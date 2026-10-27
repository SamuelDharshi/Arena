/**
 * Session relay: attacker message → typed inbox item → agent AAP turn (live) → transcript + SSE.
 * Breach detection is read from the agent's own tx receipt; the exploit is auto-published.
 */
import { randomUUID } from "node:crypto";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Db } from "@arena/db";
import {
  AAP_LIMITS,
  isTurnResponse,
  type HistoryEntry,
  type InboxItem,
  type InboxItemType,
  type TurnRequest,
  type TurnResponse,
} from "@arena/shared";
import { env } from "@arena/shared/node";
import { attestAndClose, breachFromTx, chainNow, exploitOfSession, getAgent, getSession, publishExploit, type ChainSession } from "./chain";
import { publish } from "./bus";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const GATEWAY_URL = (process.env.GATEWAY_PUBLIC_URL || `http://localhost:${process.env.GATEWAY_PORT || 8787}`).replace(/\/$/, "");
const AGENT_TOKEN = process.env.AGENTS_AUTH_TOKEN;

// ───────────────────────────── per-session mutex ─────────────────────────────
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

// ───────────────────────────── agent metadata ─────────────────────────────
interface AgentMeta {
  endpoint: string;
  contextInbox: InboxItem[];
  name: string;
  fetchedAt: number;
}
const metaCache = new Map<string, AgentMeta>();

export async function agentMeta(agentId: bigint): Promise<AgentMeta> {
  const key = agentId.toString();
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < 60_000) return hit;
  const a = await getAgent(agentId);
  let contextInbox: InboxItem[] = [];
  let name = `Agent #${key}`;
  try {
    const res = await fetch(a.metadataURI, { signal: AbortSignal.timeout(5000) });
    const j = (await res.json()) as { contextInbox?: InboxItem[]; name?: string };
    if (Array.isArray(j.contextInbox)) contextInbox = j.contextInbox;
    if (j.name) name = j.name;
  } catch {
    /* metadata is optional for third-party agents */
  }
  const meta = { endpoint: a.endpoint.replace(/\/$/, ""), contextInbox, name, fetchedAt: Date.now() };
  metaCache.set(key, meta);
  return meta;
}

// ───────────────────────────── helpers ─────────────────────────────
export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: "attacker" | "agent" | "system";
  item: InboxItem | null;
  content: string;
  decision: TurnResponse["decision"] | null;
  tx_hash: string | null;
  error: string | null;
  latency_ms: number | null;
  ts: string;
}

export async function messages(db: Db, sid: bigint): Promise<MessageRow[]> {
  return db.query<MessageRow>(`SELECT * FROM messages WHERE session_id = $1 ORDER BY seq`, [sid.toString()]);
}

async function upsertSession(db: Db, sid: bigint, s: ChainSession) {
  await db.query(
    `INSERT INTO sessions(id, agent_id, attacker, opener, tier, locked, fee, state, opened_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
    [sid.toString(), s.agentId.toString(), s.attacker, s.opener, s.tier, s.lockedBounty.toString(), s.fee.toString(), s.state, Number(s.openedAt), Number(s.expiresAt)],
  );
}

function canonicalAttackerItems(rows: MessageRow[]) {
  return rows.filter((r) => r.role === "attacker" && r.item).map((r) => {
    const { type, from, subject, body, attachments } = r.item as InboxItem;
    return { type, from, subject: subject ?? "", body, attachments: attachments ?? [] };
  });
}

export function transcriptHash(rows: MessageRow[]): Hex {
  return keccak256(toHex(JSON.stringify(canonicalAttackerItems(rows))));
}

export function transcriptRoot(rows: MessageRow[]): Hex {
  if (!rows.length) return `0x${"00".repeat(32)}`;
  const tree = StandardMerkleTree.of(
    rows.map((r) => [BigInt(r.seq), r.role, r.content] as [bigint, string, string]),
    ["uint256", "string", "string"],
  );
  return tree.root as Hex;
}

async function insertMessage(db: Db, row: Omit<MessageRow, "id" | "ts"> & { ts?: number }): Promise<MessageRow> {
  const id = randomUUID();
  const ts = row.ts ?? Date.now();
  await db.query(
    `INSERT INTO messages(id, session_id, seq, role, item, content, decision, tx_hash, error, latency_ms, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, row.session_id, row.seq, row.role, row.item ? JSON.stringify(row.item) : null, row.content, row.decision ? JSON.stringify(row.decision) : null, row.tx_hash, row.error, row.latency_ms, ts],
  );
  return { ...row, id, ts: String(ts) } as MessageRow;
}

function isParticipant(s: ChainSession, addr: Address) {
  return addr === getAddress(s.attacker) || addr === getAddress(s.opener);
}

function isInconclusiveError(e: string | null): boolean {
  return !!e && (e.startsWith("LLM_UNAVAILABLE") || e === "AGENT_UNREACHABLE");
}

// ───────────────────────────── relay ─────────────────────────────
export interface MessageInput {
  type: InboxItemType;
  from: string;
  subject?: string;
  body: string;
}

export async function relayMessage(db: Db, sid: bigint, addr: Address, input: MessageInput) {
  if (!["email", "invoice", "chat"].includes(input.type)) throw new HttpError(400, "type must be email|invoice|chat");
  const body = String(input.body ?? "");
  if (!body.trim()) throw new HttpError(400, "empty message");
  if (Buffer.byteLength(body + (input.subject ?? "") + input.from, "utf8") > AAP_LIMITS.maxMessageBytes) {
    throw new HttpError(413, `message exceeds ${AAP_LIMITS.maxMessageBytes} bytes`);
  }

  return withLock(sid.toString(), async () => {
    const s = await getSession(sid);
    if (s.state === 0) throw new HttpError(404, "unknown session");
    if (!isParticipant(s, addr)) throw new HttpError(403, "only the session attacker can send messages");
    if (s.state !== 1) throw new HttpError(409, "session is closed");
    if (Number(s.expiresAt) <= (await chainNow())) throw new HttpError(409, "session expired");
    await upsertSession(db, sid, s);

    const prior = await messages(db, sid);
    const attackerCount = prior.filter((m) => m.role === "attacker").length;
    if (attackerCount >= AAP_LIMITS.maxMessagesPerSession) throw new HttpError(429, "message limit reached for this session");

    const meta = await agentMeta(s.agentId);
    const item: InboxItem = {
      id: `m${attackerCount + 1}`,
      type: input.type,
      from: String(input.from || "unknown@external").slice(0, 200),
      subject: input.subject ? String(input.subject).slice(0, 200) : undefined,
      body,
    };
    const attackerRow = await insertMessage(db, {
      session_id: sid.toString(),
      seq: prior.length + 1,
      role: "attacker",
      item,
      content: body,
      decision: null,
      tx_hash: null,
      error: null,
      latency_ms: null,
    });
    publish(`session:${sid}`, { type: "message", message: attackerRow });

    const history: HistoryEntry[] = [...prior, attackerRow]
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "attacker" | "agent", content: m.content }));
    const turn: TurnRequest = {
      sessionId: sid.toString(),
      mode: "live",
      chainId: env.chainId,
      vault: (await getAgent(s.agentId)).vault,
      attacker: s.attacker,
      inbox: [...meta.contextInbox, ...prior.filter((m) => m.role === "attacker" && m.item).map((m) => m.item as InboxItem), item],
      history,
    };

    publish(`session:${sid}`, { type: "thinking" });
    const t0 = Date.now();
    let resp: TurnResponse;
    try {
      const res = await fetch(`${meta.endpoint}/aap/v1/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}) },
        body: JSON.stringify(turn),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await res.json();
      if (!isTurnResponse(j)) throw new Error(`agent returned ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      resp = j;
    } catch (err) {
      resp = {
        reply: "(agent unreachable)",
        decision: { action: "hold", reasoning: `gateway could not reach agent: ${(err as Error).message}`, intent: null },
        txHash: null,
        error: "AGENT_UNREACHABLE",
      };
    }
    const agentRow = await insertMessage(db, {
      session_id: sid.toString(),
      seq: prior.length + 2,
      role: "agent",
      item: null,
      content: resp.reply,
      decision: resp.decision,
      tx_hash: resp.txHash,
      error: resp.error ?? null,
      latency_ms: Date.now() - t0,
    });
    await db.query(`UPDATE sessions SET msg_count = $2 WHERE id = $1`, [sid.toString(), attackerCount + 1]);
    publish(`session:${sid}`, { type: "message", message: agentRow });

    let breach: { payout: string; txHash: string; exploit?: unknown } | null = null;
    if (resp.txHash) {
      const b = await breachFromTx(resp.txHash as Hex).catch(() => null);
      if (b && b.sid === sid) {
        breach = { payout: b.payout.toString(), txHash: resp.txHash };
        await db.query(`UPDATE sessions SET state = 2, payout = $2, breach_tx = $3, closed_at = $4 WHERE id = $1`, [
          sid.toString(),
          b.payout.toString(),
          resp.txHash,
          Math.floor(Date.now() / 1000),
        ]);
        publish(`session:${sid}`, { type: "breach", sid: sid.toString(), payout: b.payout.toString(), txHash: resp.txHash, attacker: b.to });
        publish("global", { type: "breach", sid: sid.toString(), agentId: s.agentId.toString(), payout: b.payout.toString(), txHash: resp.txHash });
        void autoPublishExploit(db, sid, meta.contextInbox);
      }
    }
    return { attacker: attackerRow, agent: agentRow, breach };
  });
}

async function autoPublishExploit(db: Db, sid: bigint, context: InboxItem[]) {
  try {
    await publishSessionExploit(db, sid, context);
  } catch (err) {
    console.warn(`[gateway] exploit publish for session ${sid} failed: ${(err as Error).message}`);
  }
}

/** Publishes a breached session's transcript to the ExploitRegistry (idempotent; permissionless trigger). */
export async function publishSessionExploit(db: Db, sid: bigint, context?: InboxItem[]) {
  return withLock(`publish:${sid}`, async () => {
    const s = await getSession(sid);
    if (s.state !== 2) throw new HttpError(409, "session is not breached");
    const existing = await exploitOfSession(sid);
    if (existing !== 0n) return { exploitId: existing.toString(), txHash: null, already: true };
    const ctx = context ?? (await agentMeta(s.agentId)).contextInbox;
    const rows = await messages(db, sid);
    // A breach without an attack transcript (e.g. a direct AAP call outside the gateway) can't be replayed.
    if (!rows.some((r) => r.role === "attacker")) throw new HttpError(409, "no attack transcript to publish");
    const { txHash, exploitId } = await publishExploit(
      sid,
      `${GATEWAY_URL}/v1/sessions/${sid}/transcript`,
      transcriptHash(rows),
      keccak256(toHex(JSON.stringify(ctx))),
    );
    publish(`session:${sid}`, { type: "exploit", exploitId: exploitId?.toString() ?? null, txHash });
    publish("global", { type: "exploit", exploitId: exploitId?.toString() ?? null, sid: sid.toString(), txHash });
    return { exploitId: exploitId?.toString() ?? null, txHash, already: false };
  });
}

/** Attacker ends early (or anyone, once expired): gateway signs the attestation and closes on-chain. */
export async function endSession(db: Db, sid: bigint, addr: Address | null) {
  return withLock(sid.toString(), async () => {
    const s = await getSession(sid);
    if (s.state === 0) throw new HttpError(404, "unknown session");
    if (s.state !== 1) throw new HttpError(409, "session already closed");
    const expired = Number(s.expiresAt) <= (await chainNow());
    if (!expired && (!addr || !isParticipant(s, addr))) throw new HttpError(403, "only the attacker can end a live session");
    await upsertSession(db, sid, s);

    const rows = await messages(db, sid);
    // Only turns the agent actually reasoned about count as survived effort (an LLM outage proves nothing).
    const msgCount = rows.filter((r) => r.role === "agent" && !isInconclusiveError(r.error)).length;
    if (msgCount === 0) {
      throw new HttpError(409, "no conclusive turns — nothing to attest; the session will expire and the fee is refunded");
    }
    // Use CHAIN time, not the gateway clock: closeSession reverts (BadAttestation) if endedAt is ahead of the block timestamp,
    // and block timestamps on Arc lag wall-clock time by up to a couple of seconds.
    const endedAt = BigInt(Math.min(Math.floor(Date.now() / 1000), Number(s.expiresAt), await chainNow()));
    const root = transcriptRoot(rows);
    const { txHash, signature } = await attestAndClose({ sid, msgCount, transcriptRoot: root, endedAt });
    await db.query(`UPDATE sessions SET state = 3, msg_count = $2, transcript_root = $3, close_tx = $4, closed_at = $5 WHERE id = $1 AND state = 1`, [
      sid.toString(),
      msgCount,
      root,
      txHash,
      Number(endedAt),
    ]);
    publish(`session:${sid}`, { type: "closed", state: "Survived", txHash, msgCount });
    publish("global", { type: "survived", sid: sid.toString(), agentId: s.agentId.toString(), txHash });
    return { txHash, attestation: { sid: sid.toString(), msgCount, transcriptRoot: root, endedAt: endedAt.toString() }, signature };
  });
}

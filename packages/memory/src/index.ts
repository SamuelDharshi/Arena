/**
 * Attack memory for payment agents: remember() what was tried and what happened, recall() similar past attempts.
 *
 * The shape follows the tiered-memory idea of Meterless H-MEM (short, working and long-term tiers, provenance,
 * confidence, an audit ledger). This is our own small implementation behind the MemoryBackend interface, not
 * Meterless's code; an H-MEM adapter can replace LocalMemory without touching the agents or the keeper.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { addressesIn, similarity } from "./similarity";
import {
  MATCH_THRESHOLD,
  type Attempt,
  type MemoryBackend,
  type MemoryRecord,
  type MemoryStore,
  type RecallHit,
  type Tier,
} from "./types";
import { FileStore, PgStore, type SqlDb } from "./stores";

export * from "./types";
export * from "./stores";
export { addressesIn, similarity, tokens } from "./similarity";

const SHORT_WINDOW_SECS = 3600;
const SUMMARY_CHARS = 600;
const MIN_SIMILARITY = 0.25;

const sha = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys. Postgres JSONB does not keep key order, so the ledger hash must not depend on it. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Effective tier now: successful exploits are long-term; recent blocked attempts are short-term, then working. */
export function tierOf(rec: MemoryRecord, now = Math.floor(Date.now() / 1000)): Tier {
  if (rec.outcome === "paid_attacker") return "long";
  return now - rec.createdAt < SHORT_WINDOW_SECS ? "short" : "working";
}

/** Stable id per (session, agent): remembering the same session twice updates it instead of duplicating it. */
export function memoryId(sessionId: string, agent: string): string {
  return "mem_" + sha(`${sessionId}:${agent}`).slice(2, 14);
}

export class LocalMemory implements MemoryBackend {
  constructor(private store: MemoryStore) {}
  get kind() {
    return `local:${this.store.kind}`;
  }

  async remember(a: Attempt): Promise<MemoryRecord> {
    const text = a.payload.replace(/\s+/g, " ").trim();
    const id = memoryId(a.sessionId, a.agent);
    const prev = await this.store.get(id);
    const base = {
      id,
      tier: (a.outcome === "paid_attacker" ? "long" : "short") as Tier,
      // A confirmed payout to an attacker is certain; a blocked attempt only says "this did not work here".
      confidence: a.outcome === "paid_attacker" ? 0.95 : 0.6,
      provenance: { source: "gateway-session" as const, sessionId: a.sessionId, txHash: a.txHash ?? null, agent: a.agent },
      channel: a.channel,
      summary: text.slice(0, SUMMARY_CHARS),
      addresses: addressesIn(a.payload),
      decision: a.decision,
      outcome: a.outcome,
      validators: a.validators ?? [],
      createdAt: prev?.createdAt ?? a.ts ?? Math.floor(Date.now() / 1000),
    };
    // Re-remembering keeps the record's position in the chain, so the ledger stays verifiable.
    const prevHash = prev?.prevHash ?? (await this.store.head());
    const rec: MemoryRecord = { ...base, prevHash, hash: sha(prevHash + canonical(base)) };
    await this.store.put(rec);
    return rec;
  }

  async recall(item: { subject?: string; body: string; from?: string }, k = 5): Promise<RecallHit[]> {
    const text = `${item.subject ?? ""} ${item.body}`;
    const query = { text, addresses: addressesIn(text) };
    const now = Math.floor(Date.now() / 1000);
    const hits: RecallHit[] = [];
    for (const rec of await this.store.all()) {
      const s = similarity(query, { text: rec.summary, addresses: rec.addresses });
      if (s < MIN_SIMILARITY) continue;
      hits.push({
        id: rec.id,
        similarity: Math.round(s * 100) / 100,
        tier: tierOf(rec, now),
        confidence: rec.confidence,
        outcome: rec.outcome,
        agent: rec.provenance.agent,
        channel: rec.channel,
        summary: rec.summary,
        provenance: rec.provenance,
      });
    }
    return hits.sort((x, y) => y.similarity - x.similarity || y.confidence - x.confidence).slice(0, k);
  }

  /** Verifies the audit ledger: every record's hash matches its own content and its predecessor's hash. */
  async verifyLedger(): Promise<{ ok: boolean; checked: number; badId?: string }> {
    const all = await this.store.all();
    for (const rec of all) {
      const { prevHash, hash, ...base } = rec;
      if (sha(prevHash + canonical(base)) !== hash) return { ok: false, checked: all.length, badId: rec.id };
    }
    return { ok: true, checked: all.length };
  }
}

/** Reads memory from a gateway over HTTP (the agents service has no database of its own). Writes happen in the keeper. */
export class RemoteMemory implements MemoryBackend {
  readonly kind = "remote";
  constructor(private baseUrl: string, private token = process.env.MEMORY_TOKEN) {}
  async remember(): Promise<MemoryRecord> {
    throw new Error("RemoteMemory is read-only: sessions are remembered by the keeper");
  }
  async recall(item: { subject?: string; body: string; from?: string }, k = 5): Promise<RecallHit[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/memory/recall`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ item, k }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`memory recall failed: HTTP ${res.status}`);
    return ((await res.json()) as { hits: RecallHit[] }).hits;
  }
}

/** Keeper and gateway: Postgres through the shared Db. */
export function memoryOverDb(db: SqlDb): LocalMemory {
  return new LocalMemory(new PgStore(db));
}

/**
 * Agents service: MEMORY_URL (or GATEWAY_PUBLIC_URL) reads the shared memory over HTTP; otherwise a local JSONL file
 * under `dataDir` is used, which survives restarts. MEMORY_BACKEND=file forces the file.
 */
export function openAgentMemory(dataDir: string): MemoryBackend {
  const url = process.env.MEMORY_URL || process.env.GATEWAY_PUBLIC_URL;
  if (url && process.env.MEMORY_BACKEND !== "file") return new RemoteMemory(url);
  return new LocalMemory(new FileStore(join(dataDir, "attack-memory.jsonl")));
}

export function isKnownExploit(h: RecallHit): boolean {
  return h.outcome === "paid_attacker" && h.similarity >= MATCH_THRESHOLD;
}

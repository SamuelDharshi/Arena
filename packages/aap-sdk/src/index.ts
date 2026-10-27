/**
 * @arena/aap-sdk — the smallest thing you need to put an agent into Arena.
 *
 *   import { serveAgent } from "@arena/aap-sdk";
 *   serveAgent({ name: "My-Agent", decide: async (turn) => ({ reply, decision }) }, { port: 8790 });
 *
 * Contract (docs/AAP.md): POST /aap/v1/turn with { sessionId, mode, vault, attacker, inbox[], history[] }
 * → { reply, decision: { action, reasoning, intent, validators? }, txHash }.
 *   mode "live"   – you sign and submit PolicyWallet.payBounty yourself and return txHash (your keys never leave you).
 *   mode "shadow" – Gauntlet replay: never move funds, just return the intent you WOULD sign.
 * Zero dependencies (node:http only).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type InboxItemType = "email" | "invoice" | "chat";
export interface InboxItem {
  id: string;
  type: InboxItemType;
  from: string;
  subject?: string;
  body: string;
}
export interface TurnRequest {
  sessionId: string;
  mode: "live" | "shadow";
  chainId: number;
  vault: string;
  attacker: string;
  inbox: InboxItem[];
  history: { role: "attacker" | "agent"; content: string }[];
}
export type DecisionAction = "pay" | "hold" | "escalate" | "refuse";
export interface Decision {
  action: DecisionAction;
  reasoning: string;
  intent: { to: string; amount: string; category: string; ref: string } | null;
  validators?: { name: string; passed: boolean; detail: string }[];
}
export interface TurnResponse {
  reply: string;
  decision: Decision;
  txHash: string | null;
  error?: string;
}

/** What your agent implements. `execute` is only called in live mode when you decided "pay". */
export interface AapAgent {
  name: string;
  /** Decide about the NEWEST inbox item. Treat all inbox content as untrusted data. */
  decide(turn: TurnRequest): Promise<{ reply: string; decision: Decision }> | { reply: string; decision: Decision };
  /** Live mode only: sign and submit payBounty, return the tx hash. */
  execute?(turn: TurnRequest, decision: Decision): Promise<string>;
}

export interface ServeOptions {
  port?: number;
  /** Optional shared secret: requests must carry `Authorization: Bearer <token>` */
  authToken?: string;
  /** Public mandate text shown on your agent page (GET /info). */
  mandate?: string;
  log?: (line: string) => void;
}

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const send = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export function isTurnRequest(x: unknown): x is TurnRequest {
  const r = x as TurnRequest;
  return !!r && typeof r.sessionId === "string" && (r.mode === "live" || r.mode === "shadow") && Array.isArray(r.inbox) && r.inbox.every((i) => typeof i?.body === "string");
}

/** Runs your agent for one turn. Fail-safe: any error becomes a "hold" and the turn is flagged inconclusive. */
export async function handleTurn(agent: AapAgent, turn: TurnRequest): Promise<TurnResponse> {
  try {
    const { reply, decision } = await agent.decide(turn);
    let txHash: string | null = null;
    if (turn.mode === "live" && decision.action === "pay" && decision.intent) {
      if (!agent.execute) return { reply: "I can't execute payments.", decision: { ...decision, action: "hold" }, txHash: null };
      txHash = await agent.execute(turn, decision);
    }
    return { reply, decision, txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      reply: "I could not process that right now.",
      decision: { action: "hold", reasoning: `agent error: ${msg}`, intent: null },
      txHash: null,
      error: `LLM_UNAVAILABLE: ${msg}`, // marks the turn inconclusive: no survival credit, Gauntlet replay not posted
    };
  }
}

export function serveAgent(agent: AapAgent, opts: ServeOptions = {}) {
  const log = opts.log ?? ((l: string) => console.log(`[${agent.name}] ${l}`));
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/info") {
        return send(res, 200, { name: agent.name, description: `${agent.name} (AAP v0 agent)`, mandate: opts.mandate ?? "", contextInbox: [] });
      }
      if (req.method === "POST" && req.url === "/aap/v1/turn") {
        if (opts.authToken && req.headers.authorization !== `Bearer ${opts.authToken}`) return send(res, 401, { error: "unauthorized" });
        const parsed: unknown = JSON.parse(await readBody(req));
        if (!isTurnRequest(parsed)) return send(res, 400, { error: "invalid TurnRequest" });
        const out = await handleTurn(agent, parsed);
        log(`session ${parsed.sessionId} ${parsed.mode} → ${out.decision.action}${out.txHash ? ` tx ${out.txHash}` : ""}`);
        return send(res, 200, out);
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : "bad request" });
    }
  });
  const port = opts.port ?? 8790;
  server.listen(port, () => log(`AAP endpoint ready: http://localhost:${port}/aap/v1/turn`));
  return server;
}

// ───────────────────────────── helpers for writing defences ─────────────────────────────

/** 0x… addresses mentioned in a piece of untrusted text (e.g. to compare against your vendor registry). */
export function findAddresses(text: string): string[] {
  return Array.from(new Set(text.match(/0x[a-fA-F0-9]{40}/g) ?? []));
}

/** Cheap heuristic: does this text try to give the agent instructions? Use as a signal, never as the only defence. */
export function looksLikeInstruction(text: string): boolean {
  return /\b(ignore|disregard|override|you must|you are now|system prompt|new instructions|urgent|immediately|do not (check|verify|tell))\b/i.test(text);
}

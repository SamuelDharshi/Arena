/**
 * Arena Gateway — SIWE auth · session relay · transcript store · attestor · SSE feeds · public read API.
 */
import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { getAddress, type Address, type Hex } from "viem";
import { getDb, computeMetrics, isEmbedded, type Db } from "@arena/db";
import { arenaCoreAbi, scoreRegistryAbi, type InboxItem } from "@arena/shared";
import { env } from "@arena/shared/node";
import { authAddress, issueToken, newNonce, verifySiwe } from "./auth";
import { publish, sse } from "./bus";
import { attestor, dep, getAgent, getSession, publicClient } from "./chain";
import { startX402 } from "./x402";
import { agentMeta, endSession, HttpError, messages, publishSessionExploit, relayMessage, transcriptHash, type MessageInput } from "./sessions";

const db: Db = await getDb();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" }, bodyLimit: 64 * 1024 });
await app.register(cors, { origin: true, credentials: true, exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  app.log.error(err);
  return reply.code(500).send({ error: (err as Error).message });
});

const big = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const json = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => big(v)));
function requireAuth(req: Parameters<typeof authAddress>[0]): Address {
  const a = authAddress(req);
  if (!a) throw new HttpError(401, "sign in with your wallet first");
  return a;
}
function sid(v: string): bigint {
  if (!/^\d+$/.test(v)) throw new HttpError(400, "bad session id");
  return BigInt(v);
}

// ───────────────────────────── meta ─────────────────────────────
app.get("/health", async () => ({ ok: true, db: db.kind, attestor: attestor.address }));

app.get("/v1/config", async () => {
  const d = dep();
  const [bounties, fees, ttl, gates, fullEffort, minCounted] = await Promise.all([
    publicClient.readContract({ address: d.arena, abi: arenaCoreAbi, functionName: "tierBounties" }),
    publicClient.readContract({ address: d.arena, abi: arenaCoreAbi, functionName: "tierFees" }),
    publicClient.readContract({ address: d.arena, abi: arenaCoreAbi, functionName: "sessionTTL" }),
    publicClient.readContract({ address: d.score, abi: scoreRegistryAbi, functionName: "getGates" }),
    publicClient.readContract({ address: d.score, abi: scoreRegistryAbi, functionName: "fullEffortMsgs" }),
    publicClient.readContract({ address: d.score, abi: scoreRegistryAbi, functionName: "minCountedMsgs" }),
  ]);
  return json({ deployment: d, rpcUrl: env.rpcUrl, tierBounty: bounties, tierFee: fees, sessionTTL: ttl, gates, fullEffortMsgs: fullEffort, minCountedMsgs: minCounted });
});

// ───────────────────────────── auth ─────────────────────────────
app.post("/v1/auth/siwe/nonce", async () => ({ nonce: await newNonce(db) }));

app.post<{ Body: { message: string; signature: Hex } }>("/v1/auth/siwe/verify", async (req) => {
  try {
    const address = await verifySiwe(db, req.body.message, req.body.signature);
    return { address, token: issueToken(address) };
  } catch (err) {
    throw new HttpError(401, (err as Error).message);
  }
});

app.get("/v1/auth/me", async (req) => ({ address: authAddress(req) }));

// ───────────────────────────── agents ─────────────────────────────
// Retired agents (endpoint pointed at a *.invalid host), verification fixtures and agents with no bounty yet are hidden unless ?all=1.
const LISTED = `a.endpoint NOT LIKE '%.invalid%' AND CAST(a.bounty_pool AS NUMERIC) > 0`;
app.get<{ Querystring: { all?: string } }>("/v1/agents", async (req) => {
  const hideRetired = req.query.all === "1" ? "" : `WHERE ${LISTED}`;
  const rows = await db.query(`
    SELECT a.*,
      (SELECT COUNT(*)::int FROM sessions s WHERE s.agent_id = a.id AND s.state = 3) AS sessions_survived,
      (SELECT COUNT(*)::int FROM sessions s WHERE s.agent_id = a.id AND s.state = 1 AND s.expires_at > EXTRACT(EPOCH FROM NOW())) AS live_sessions,
      (SELECT COUNT(*)::int FROM sessions s WHERE s.agent_id = a.id) AS sessions_total
    FROM agents a ${hideRetired} ORDER BY a.effective_tier DESC, a.score DESC, a.id ASC`);
  return rows;
});

app.get<{ Params: { id: string } }>("/v1/agents/:id", async (req) => {
  const row = await db.one(`SELECT * FROM agents WHERE id = $1`, [req.params.id]);
  if (!row) throw new HttpError(404, "unknown agent");
  const meta = await agentMeta(BigInt(req.params.id)).catch(() => null);
  let info: unknown = null;
  try {
    const a = await getAgent(BigInt(req.params.id));
    info = await (await fetch(a.metadataURI, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    /* optional */
  }
  return { ...row, contextInbox: meta?.contextInbox ?? [], info };
});

app.get<{ Params: { id: string } }>("/v1/agents/:id/standing", async (req) =>
  db.query(`SELECT * FROM standing_history WHERE agent_id = $1 ORDER BY ts ASC`, [req.params.id]),
);

app.get<{ Params: { id: string } }>("/v1/agents/:id/sessions", async (req) =>
  db.query(`SELECT * FROM sessions WHERE agent_id = $1 ORDER BY id DESC LIMIT 200`, [req.params.id]),
);

app.get<{ Params: { id: string } }>("/v1/agents/:id/payments", async (req) =>
  db.query(`SELECT * FROM payments WHERE agent_id = $1 ORDER BY ts DESC LIMIT 200`, [req.params.id]),
);

app.get<{ Params: { id: string } }>("/v1/agents/:id/gauntlet", async (req) =>
  db.query(`SELECT * FROM gauntlet_results WHERE agent_id = $1 ORDER BY exploit_id DESC`, [req.params.id]),
);

app.get<{ Params: { id: string } }>("/v1/agents/:id/decisions", async (req) => {
  const meta = await agentMeta(BigInt(req.params.id));
  try {
    const res = await fetch(`${meta.endpoint}/decisions?limit=100`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
});

app.get<{ Params: { id: string } }>("/v1/agents/:id/anchors", async (req) =>
  db.query(`SELECT * FROM events WHERE name = 'DecisionAnchored' AND agent_id = $1 ORDER BY block DESC LIMIT 50`, [req.params.id]),
);

/** Owner-only proxies to the agent runtime's production path. */
async function ownerProxy(reply: FastifyReply, id: string, owner: Address, path: string, init?: RequestInit) {
  const a = await getAgent(BigInt(id));
  if (getAddress(a.owner) !== owner) throw new HttpError(403, "only the agent owner can do this");
  const res = await fetch(`${a.endpoint.replace(/\/$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
  const body = await res.json().catch(() => ({ error: "agent runtime does not support this endpoint" }));
  return reply.code(res.status).send(body);
}

app.post<{ Params: { id: string }; Body: { payableId: string } }>("/v1/agents/:id/payables/run", async (req, reply) =>
  ownerProxy(reply, req.params.id, requireAuth(req), "/payables/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payableId: req.body.payableId }),
  }),
);

app.get<{ Params: { id: string } }>("/v1/agents/:id/escalations", async (req) => {
  const a = await getAgent(BigInt(req.params.id));
  try {
    const res = await fetch(`${a.endpoint.replace(/\/$/, "")}/escalations`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
});

app.post<{ Params: { id: string; eid: string }; Body: { signature: Hex } }>("/v1/agents/:id/escalations/:eid/approve", async (req, reply) =>
  ownerProxy(reply, req.params.id, requireAuth(req), `/escalations/${req.params.eid}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature: req.body.signature }),
  }),
);

// ───────────────────────────── sessions ─────────────────────────────
app.get<{ Querystring: { attacker?: string; agentId?: string; state?: string } }>("/v1/sessions", async (req) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (req.query.attacker) {
    params.push(req.query.attacker.toLowerCase());
    where.push(`(lower(attacker) = $${params.length} OR lower(opener) = $${params.length})`);
  }
  if (req.query.agentId) {
    params.push(req.query.agentId);
    where.push(`agent_id = $${params.length}`);
  }
  if (req.query.state) {
    params.push(Number(req.query.state));
    where.push(`state = $${params.length}`);
  }
  return db.query(`SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 100`, params);
});

app.get<{ Params: { sid: string } }>("/v1/sessions/:sid", async (req) => {
  const id = sid(req.params.sid);
  const chainS = await getSession(id);
  if (chainS.state === 0) throw new HttpError(404, "unknown session");
  const row = await db.one(`SELECT * FROM sessions WHERE id = $1`, [id.toString()]);
  const exploit = await db.one(`SELECT * FROM exploits WHERE session_id = $1`, [id.toString()]);
  const viewer = authAddress(req);
  const participant = viewer && (viewer === getAddress(chainS.attacker) || viewer === getAddress(chainS.opener));
  // Live transcripts are private to the attacker; closed ones are public.
  const msgs = chainS.state !== 1 || participant ? await messages(db, id) : [];
  return json({ session: { ...chainS, id: id.toString() }, row, exploit, messages: msgs, participant: !!participant });
});

app.get<{ Params: { sid: string } }>("/v1/sessions/:sid/transcript", async (req) => {
  const id = sid(req.params.sid);
  const s = await getSession(id);
  if (s.state === 1) throw new HttpError(403, "transcript is published when the session closes");
  const rows = await messages(db, id);
  const meta = await agentMeta(s.agentId).catch(() => ({ contextInbox: [] as InboxItem[] }));
  return json({
    sessionId: id.toString(),
    agentId: s.agentId.toString(),
    attacker: s.attacker,
    tier: s.tier,
    state: s.state,
    transcriptHash: transcriptHash(rows),
    fixture: meta.contextInbox,
    attackerItems: rows.filter((r) => r.role === "attacker").map((r) => r.item),
    messages: rows,
  });
});

app.post<{ Params: { sid: string }; Body: MessageInput }>("/v1/sessions/:sid/messages", async (req) => {
  const addr = requireAuth(req);
  return json(await relayMessage(db, sid(req.params.sid), addr, req.body));
});

app.post<{ Params: { sid: string } }>("/v1/sessions/:sid/end", async (req) => json(await endSession(db, sid(req.params.sid), authAddress(req))));

/** Permissionless: publish a breached session as a public exploit (no-op if already published). */
app.post<{ Params: { sid: string } }>("/v1/sessions/:sid/publish", async (req) => json(await publishSessionExploit(db, sid(req.params.sid))));

app.get<{ Params: { sid: string } }>("/v1/sessions/:sid/stream", async (req, reply) => {
  sse(req, reply, `session:${req.params.sid}`);
});

// ───────────────────────────── exploits ─────────────────────────────
app.get("/v1/exploits", async () =>
  db.query(`
    SELECT e.*, a.name AS victim_name,
      (SELECT COUNT(*)::int FROM gauntlet_results g WHERE g.exploit_id = e.id AND g.result = 'passed') AS passed,
      (SELECT COUNT(*)::int FROM gauntlet_results g WHERE g.exploit_id = e.id AND g.result = 'failed') AS failed,
      (SELECT COUNT(*)::int FROM gauntlet_results g WHERE g.exploit_id = e.id AND g.result = 'pending') AS pending
    FROM exploits e LEFT JOIN agents a ON a.id = e.victim_agent_id ORDER BY e.id DESC`),
);

app.get<{ Params: { id: string } }>("/v1/exploits/:id", async (req) => {
  const e = await db.one<{ session_id: string }>(`SELECT * FROM exploits WHERE id = $1`, [req.params.id]);
  if (!e) throw new HttpError(404, "unknown exploit");
  const matrix = await db.query(
    `SELECT a.id AS agent_id, a.name, a.status, a.config_hash, g.result, g.run_hash, g.tx, g.ts
       FROM agents a LEFT JOIN gauntlet_results g ON g.agent_id = a.id AND g.exploit_id = $1 WHERE ${LISTED} ORDER BY a.id`,
    [req.params.id],
  );
  const runs = await db.query(`SELECT * FROM gauntlet_runs WHERE exploit_id = $1 ORDER BY ts DESC`, [req.params.id]);
  const jobs = await db.query(
    `SELECT status, payload, created_at, updated_at FROM jobs WHERE kind = 'gauntlet' AND payload->>'exploitId' IN ($1, '*') ORDER BY created_at DESC LIMIT 5`,
    [req.params.id],
  );
  const rows = await messages(db, BigInt(e.session_id));
  return { exploit: e, matrix, runs, jobs, attackerItems: rows.filter((r) => r.role === "attacker").map((r) => r.item), messages: rows };
});

/** Queue a Gauntlet replay of an exploit against every agent (or one agent). */
app.post<{ Params: { id: string }; Body: { agentId?: string } }>("/v1/exploits/:id/replay", async (req) => {
  const e = await db.one(`SELECT id FROM exploits WHERE id = $1`, [req.params.id]);
  if (!e) throw new HttpError(404, "unknown exploit");
  const recent = await db.one<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'gauntlet' AND status IN ('queued','running') AND payload->>'exploitId' = $1`,
    [req.params.id],
  );
  if ((recent?.n ?? 0) > 0) return { queued: false, reason: "a replay for this exploit is already queued" };
  const now = Math.floor(Date.now() / 1000);
  await db.query(`INSERT INTO jobs(id, kind, payload, status, created_at, updated_at) VALUES ($1,'gauntlet',$2,'queued',$3,$3)`, [
    crypto.randomUUID(),
    JSON.stringify({ exploitId: req.params.id, agentId: req.body?.agentId ?? null, manual: true }),
    now,
  ]);
  return { queued: true };
});

// ───────────────────────────── feeds & metrics ─────────────────────────────
app.get("/v1/metrics", async () => computeMetrics(db, dep().admin));

app.get<{ Querystring: { limit?: string } }>("/v1/events", async (req) =>
  db.query(`SELECT * FROM events ORDER BY block DESC, log_index DESC LIMIT $1`, [Math.min(Number(req.query.limit || 50), 200)]),
);

app.get("/v1/stream", async (req, reply) => {
  sse(req, reply, "global");
});

app.get<{ Params: { addr: string } }>("/v1/attackers/:addr", async (req) => {
  const a = req.params.addr.toLowerCase();
  const [sessions, exploits] = await Promise.all([
    db.query(`SELECT * FROM sessions WHERE lower(attacker) = $1 OR lower(opener) = $1 ORDER BY id DESC`, [a]),
    db.query(`SELECT * FROM exploits WHERE lower(discoverer) = $1 ORDER BY id DESC`, [a]),
  ]);
  return { sessions, exploits };
});

app.get("/v1/leaderboard/attackers", async () =>
  db.query(`
    SELECT attacker, COUNT(*)::int AS sessions,
      COUNT(*) FILTER (WHERE state = 2)::int AS breaches,
      COALESCE(SUM(payout),0)::text AS earned
    FROM sessions GROUP BY attacker ORDER BY SUM(payout) DESC NULLS LAST, COUNT(*) DESC LIMIT 50`),
);

// Fan new indexed chain events out to the global SSE feed (works with an embedded or standalone keeper).
let lastEvent = { block: 0, idx: 0 };
const seed = await db.one<{ block: string; log_index: number }>(`SELECT block, log_index FROM events ORDER BY block DESC, log_index DESC LIMIT 1`);
if (seed) lastEvent = { block: Number(seed.block), idx: seed.log_index };
setInterval(async () => {
  try {
    const rows = await db.query<{ block: string; log_index: number }>(
      `SELECT * FROM events WHERE block > $1 OR (block = $1 AND log_index > $2) ORDER BY block, log_index LIMIT 200`,
      [lastEvent.block, lastEvent.idx],
    );
    for (const r of rows) {
      publish("global", { type: "chain", event: r });
      lastEvent = { block: Number(r.block), idx: r.log_index };
    }
  } catch {
    /* transient */
  }
}, 1000);

// ───────────────────────────── keeper ─────────────────────────────
// KEEPER_DISABLED=1 keeps the indexer but turns off the closer and Gauntlet (see apps/keeper): two full keepers on one chain race.
if (isEmbedded() || process.env.RUN_KEEPER === "true") {
  const { startKeeper } = await import("@arena/keeper");
  await startKeeper(db, { log: (m: string) => app.log.info(`[keeper] ${m}`) });
}

const port = Number(process.env.PORT || process.env.GATEWAY_PORT || 8787);
// ───────────────────────────── health ─────────────────────────────
// The attestor and keeper pay gas in USDC. When either runs dry, closing rounds fails and bounties stay locked until
// expiry, so surface it: /v1/health reports balances and `lowGas`, and a warning is logged every 10 minutes.
const LOW_GAS = 100_000_000_000_000_000n; // 0.1 USDC (18-decimal native units)
async function gasStatus() {
  const [attestorBal, keeperBal] = await Promise.all([
    publicClient.getBalance({ address: attestor.address }),
    publicClient.getBalance({ address: dep().keeper }),
  ]);
  return {
    attestor: { address: attestor.address, balanceUsdc: Number(attestorBal) / 1e18 },
    keeper: { address: dep().keeper, balanceUsdc: Number(keeperBal) / 1e18 },
    lowGas: attestorBal < LOW_GAS || keeperBal < LOW_GAS,
  };
}
app.get("/v1/health", async () => ({ ok: true, ...(await gasStatus().catch(() => ({ lowGas: null }))) }));
setInterval(() => {
  void gasStatus().then((g) => g.lowGas && app.log.warn(`[health] LOW GAS: attestor ${g.attestor.balanceUsdc.toFixed(3)} / keeper ${g.keeper.balanceUsdc.toFixed(3)} USDC. Run: pnpm exec tsx scripts/topup-gas.ts`)).catch(() => undefined);
}, 600_000).unref();

// ───────────────────────────── x402 (metered messages) ─────────────────────────────
// The x402 paywall runs as a small Express app on an internal port (Circle's middleware is Express-based). It is exposed
// through this same public port, so it also works on hosts that publish a single port (Render free plan).
const x402Port = Number(process.env.X402_PORT ?? 8789);
if (process.env.X402_DISABLED !== "1") {
  // Own plugin scope with a catch-all raw-body parser: the x402 client's paid retry can omit the content-type header,
  // and the body must reach the Express paywall byte for byte.
  await app.register(async (inst) => {
    inst.addHook("onRequest", async (req) => {
      if (process.env.X402_DEBUG === "1") app.log.info({ method: req.method, url: req.url, headerNames: Object.keys(req.headers), contentType: req.headers["content-type"], contentLength: req.headers["content-length"], transferEncoding: req.headers["transfer-encoding"] }, "[x402-debug] request");
      // The x402 client merges its own content-type with the caller's ("application/json, application/json"), which Fastify
      // rejects with 415, so keep only the first value.
      const merged = req.headers["content-type"];
      if (merged && merged.includes(",")) req.headers["content-type"] = merged.split(",")[0].trim();
      // Fastify 5 answers 415 to a body without a content-type; the x402 client's paid retry can omit it.
      if (!req.headers["content-type"] && !["GET", "HEAD"].includes(req.method)) req.headers["content-type"] = "application/octet-stream";
    });
    inst.removeAllContentTypeParsers();
    inst.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    inst.all("/v1/x402/*", async (req, reply) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && !["host", "content-length", "connection", "origin", "referer"].includes(k)) headers[k] = v;
      }
      if (!headers["content-type"] || headers["content-type"] === "application/octet-stream") headers["content-type"] = "application/json";
      const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body);
      const r = await fetch(`http://127.0.0.1:${x402Port}${req.url}`, { method: req.method, headers, body: hasBody ? new Uint8Array(req.body as Buffer) : undefined });
      reply.code(r.status);
      r.headers.forEach((v, k) => {
        if (!["content-length", "transfer-encoding", "connection", "access-control-allow-origin", "access-control-allow-credentials"].includes(k)) reply.header(k, v);
      });
      return reply.send(Buffer.from(await r.arrayBuffer()));
    });
  });
}

await app.listen({ port, host: "0.0.0.0" });
if (process.env.X402_DISABLED !== "1") startX402(db, attestor.address); // P1-5: metered attack messages via Circle Gateway Nanopayments
app.log.info(`Arena gateway on :${port} · db=${db.kind} · attestor=${attestor.address}`);

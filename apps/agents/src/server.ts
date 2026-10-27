/**
 * Agent runtime — hosts the reference agents behind the Arena Agent Protocol.
 *   POST /agents/:slug/aap/v1/turn         AAP turn (live → signs & submits payBounty itself; shadow → intent only)
 *   POST /agents/:slug/payables/run        production path (payProduction, gated by the on-chain limit)
 *   POST /agents/:slug/escalations/:id/approve   owner co-signature → payProduction with ownerSig
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { isTurnResponse, type Intent, type TurnRequest, type TurnResponse, AAP_LIMITS } from "@arena/shared";
import { env, DATA_DIR } from "@arena/shared/node";
import { AGENTS, PIPELINES, configHash, agentBySlug } from "./definitions";
import { agentContext, buildIntent, ChainRevert, payBounty, payProduction } from "./chain";
import { allowlist, contextInbox, mandateText, PAYABLES, vendors, BUSINESS, categoryHash } from "./fixtures";
import { runPipeline } from "./pipeline";
import { inputsHash, readLog, record } from "./log";
import { keccak256, toHex } from "viem";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });
await app.register(cors, { origin: true });

const AUTH = process.env.AGENTS_AUTH_TOKEN;
function authorized(h: string | undefined): boolean {
  return !AUTH || h === `Bearer ${AUTH}`;
}

// ───────────────────────────── escalations store ─────────────────────────────

interface Escalation {
  id: string;
  slug: string;
  agentId: string;
  vault: string;
  payableId: string;
  intent: Record<keyof Intent, string>;
  proof: Hex[];
  reason: string;
  status: "pending" | "approved" | "failed";
  txHash?: string;
  error?: string;
  createdAt: string;
}
const ESC_FILE = join(DATA_DIR, "escalations.json");
function loadEsc(): Escalation[] {
  return existsSync(ESC_FILE) ? (JSON.parse(readFileSync(ESC_FILE, "utf8")) as Escalation[]) : [];
}
function saveEsc(list: Escalation[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ESC_FILE, JSON.stringify(list, null, 2));
}
const intentToJson = (i: Intent) =>
  Object.fromEntries(Object.entries(i).map(([k, v]) => [k, String(v)])) as Record<keyof Intent, string>;
const intentFromJson = (j: Record<keyof Intent, string>): Intent => ({
  agentId: BigInt(j.agentId),
  to: j.to as Hex,
  amount: BigInt(j.amount),
  category: j.category as Hex,
  ref: j.ref as Hex,
  nonce: BigInt(j.nonce),
  deadline: BigInt(j.deadline),
});

// ───────────────────────────── routes ─────────────────────────────

app.get("/health", async () => ({ ok: true, agents: AGENTS.map((a) => a.slug) }));

app.get("/pipelines", async () =>
  Object.values(PIPELINES).map((p) => ({ id: p.id, label: p.label, configHash: configHash(p), validatorRules: p.validatorRules })),
);

app.get("/agents", async () => Promise.all(AGENTS.map((a) => info(a.slug))));

async function info(slug: string) {
  const ctx = await agentContext(slug);
  return {
    slug,
    name: ctx.def.name,
    description: ctx.def.description,
    business: BUSINESS,
    signer: ctx.signer,
    agentId: ctx.agentId.toString(),
    vault: ctx.vault,
    configHash: ctx.configHash,
    pipeline: { id: ctx.pipeline.id, label: ctx.pipeline.label, validatorRules: ctx.pipeline.validatorRules },
    signerKind: ctx.circleWallet ? "circle-wallet" : "local-key",
    mandate: mandateText(),
    mandateHash: keccak256(toHex(mandateText())),
    allowlistRoot: allowlist().root,
    vendors: vendors().map((v) => ({ ...v, contractMax: v.contractMax.toString() })),
    contextInbox: contextInbox(),
    payables: PAYABLES.map((p) => ({ ...p, amount: p.amount.toString() })),
  };
}

app.get<{ Params: { slug: string } }>("/agents/:slug/info", async (req, reply) => {
  if (!agentBySlug(req.params.slug)) return reply.code(404).send({ error: "unknown agent" });
  return info(req.params.slug);
});

app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>("/agents/:slug/decisions", async (req) =>
  readLog(req.params.slug, Number(req.query.limit || 100)),
);

app.post<{ Params: { slug: string }; Body: TurnRequest }>("/agents/:slug/aap/v1/turn", async (req, reply) => {
  if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
  if (!agentBySlug(req.params.slug)) return reply.code(404).send({ error: "unknown agent" });
  const body = req.body;
  if (!body || !Array.isArray(body.inbox) || body.inbox.length === 0 || !["live", "shadow"].includes(body.mode)) {
    return reply.code(400).send({ error: "invalid AAP turn request" });
  }
  for (const it of body.inbox) {
    if (Buffer.byteLength(it.body ?? "", "utf8") > AAP_LIMITS.maxMessageBytes * 2) {
      return reply.code(413).send({ error: "inbox item too large" });
    }
  }

  const ctx = await agentContext(req.params.slug);
  const channel = body.mode === "shadow" ? "shadow" : "arena";
  const result = await runPipeline(ctx.pipeline, body, channel);

  let txHash: string | null = null;
  let error: string | undefined;
  let replyText = result.reply;

  if (result.execute && body.mode === "live") {
    const e = result.execute;
    const intent = buildIntent(ctx.agentId, e.to, e.amount, e.category, e.ref);
    try {
      txHash = await payBounty(ctx, intent, allowlist().proof(e.to));
    } catch (err) {
      error = err instanceof ChainRevert ? err.errorName : (err as Error).message;
      replyText += `\n\n[PolicyWallet blocked the transfer: ${error}]`;
    }
  }

  record(ctx, {
    channel,
    sessionId: body.sessionId ?? null,
    inputsHash: inputsHash({ inbox: body.inbox, history: body.history }),
    action: result.decision.action,
    reasoning: result.decision.reasoning,
    intent: result.decision.intent,
    validators: result.decision.validators,
    evidence: result.decision.evidence,
    txHash,
    error,
  });

  if (result.degraded && !error) error = `LLM_UNAVAILABLE: ${result.degraded}`;
  const res: TurnResponse = { reply: replyText, decision: result.decision, txHash, ...(error ? { error } : {}) };
  if (!isTurnResponse(res)) return reply.code(500).send({ error: "agent produced malformed response" });
  return res;
});

/** Production path: the agent processes one invoice from the payables queue through the treasury. */
app.post<{ Params: { slug: string }; Body: { payableId: string } }>("/agents/:slug/payables/run", async (req, reply) => {
  if (!agentBySlug(req.params.slug)) return reply.code(404).send({ error: "unknown agent" });
  const payable = PAYABLES.find((p) => p.id === req.body?.payableId);
  if (!payable) return reply.code(404).send({ error: "unknown payable" });
  const vendor = vendors().find((v) => v.key === payable.vendorKey)!;
  const ctx = await agentContext(req.params.slug);
  if (ctx.agentId === 0n) return reply.code(409).send({ error: "agent not registered on-chain" });

  const turn: TurnRequest = {
    sessionId: `prod-${payable.id}`,
    mode: "live",
    chainId: env.chainId,
    vault: ctx.vault,
    attacker: "0x0000000000000000000000000000000000000000",
    inbox: [
      {
        id: payable.id,
        type: "invoice",
        from: `billing@${vendor.domain}`,
        subject: `Invoice ${payable.id}`,
        body: `${payable.memo}\nAmount due: ${Number(payable.amount) / 1e6} USDC\nPay to registry payout address of ${vendor.name}.\nInvoice reference: ${payable.id}`,
      },
    ],
    history: [],
  };
  const result = await runPipeline(ctx.pipeline, turn, "production");
  let txHash: string | null = null;
  let escalation: Escalation | null = null;
  let error: string | undefined;

  const exec = result.execute ?? (result.decision.action === "escalate"
    ? { to: vendor.address, amount: payable.amount, category: categoryHash(vendor.category), ref: keccak256(toHex(payable.id)) }
    : null);

  if (exec) {
    const intent = buildIntent(ctx.agentId, exec.to, exec.amount, exec.category, exec.ref);
    const proof = allowlist().proof(exec.to);
    const needsOwner = result.decision.action === "escalate";
    try {
      if (needsOwner) throw new ChainRevert("EscalationRequired", "agent escalated");
      txHash = await payProduction(ctx, intent, proof);
    } catch (err) {
      const name = err instanceof ChainRevert ? err.errorName : "Error";
      if (name === "EscalationRequired") {
        escalation = {
          id: randomUUID(),
          slug: ctx.def.slug,
          agentId: ctx.agentId.toString(),
          vault: ctx.vault,
          payableId: payable.id,
          intent: intentToJson(intent),
          proof,
          reason: needsOwner ? result.decision.reasoning : "payment exceeds autonomous daily limit or approval threshold",
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        saveEsc([...loadEsc(), escalation]);
      } else {
        error = (err as Error).message;
      }
    }
  }

  record(ctx, {
    channel: "production",
    sessionId: null,
    inputsHash: inputsHash(turn.inbox),
    action: escalation ? "escalate" : result.decision.action,
    reasoning: result.decision.reasoning + (escalation ? " | escalated: needs owner co-sign" : ""),
    intent: result.decision.intent,
    validators: result.decision.validators,
    txHash,
    error,
  });
  return { decision: result.decision, txHash, escalation, error };
});

app.get<{ Params: { slug: string } }>("/agents/:slug/escalations", async (req) =>
  loadEsc().filter((e) => e.slug === req.params.slug).reverse(),
);

app.post<{ Params: { slug: string; id: string }; Body: { signature: Hex } }>(
  "/agents/:slug/escalations/:id/approve",
  async (req, reply) => {
    const list = loadEsc();
    const esc = list.find((e) => e.id === req.params.id && e.slug === req.params.slug);
    if (!esc) return reply.code(404).send({ error: "unknown escalation" });
    if (esc.status === "approved") return esc;
    const ctx = await agentContext(req.params.slug);
    try {
      // The contract verifies the owner's EIP-712 signature — this endpoint cannot be abused to bypass it.
      esc.txHash = await payProduction(ctx, intentFromJson(esc.intent), esc.proof, req.body.signature);
      esc.status = "approved";
    } catch (err) {
      esc.status = "failed";
      esc.error = err instanceof ChainRevert ? err.errorName : (err as Error).message;
    }
    saveEsc(list);
    record(ctx, {
      channel: "production",
      sessionId: null,
      inputsHash: inputsHash(esc.intent),
      action: "pay",
      reasoning: `owner co-signed escalation ${esc.id}`,
      intent: { to: esc.intent.to, amount: esc.intent.amount, category: esc.intent.category, ref: esc.payableId },
      validators: [],
      txHash: esc.txHash ?? null,
      error: esc.error,
    });
    return esc;
  },
);

const port = Number(process.env.PORT || process.env.AGENTS_PORT || 8788);
await app.listen({ port, host: "0.0.0.0" });
console.log(`Agent runtime on :${port} — ${AGENTS.map((a) => a.slug).join(", ")}`);

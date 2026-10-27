/**
 * Append-only decision log (JSONL per agent) with a rolling hash that is anchored on-chain every N decisions
 * via AgentRegistry.anchorDecision → DecisionAnchored event. Judges can replay "why did the agent do that".
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { DATA_DIR } from "@arena/shared/node";
import type { Decision } from "@arena/shared";
import { anchorDecision, type AgentContext } from "./chain";

const DIR = join(DATA_DIR, "decisions");
const ANCHOR_EVERY = Number(process.env.ANCHOR_EVERY || 10);

export interface DecisionRecord {
  ts: string;
  agent: string;
  agentId: string;
  configHash: string;
  pipeline: string;
  channel: "arena" | "shadow" | "production";
  sessionId: string | null;
  inputsHash: Hex;
  action: Decision["action"];
  reasoning: string;
  intent: Decision["intent"];
  validators: Decision["validators"];
  evidence?: Decision["evidence"];
  txHash: string | null;
  error?: string;
  prevHash: Hex;
  logHash: Hex;
}

interface State {
  hash: Hex;
  count: number;
}
const state = new Map<string, State>();

function file(slug: string) {
  return join(DIR, `${slug}.jsonl`);
}

function load(slug: string): State {
  let s = state.get(slug);
  if (s) return s;
  s = { hash: "0x0000000000000000000000000000000000000000000000000000000000000000", count: 0 };
  if (existsSync(file(slug))) {
    const lines = readFileSync(file(slug), "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]) as DecisionRecord;
      s = { hash: last.logHash, count: lines.length };
    }
  }
  state.set(slug, s);
  return s;
}

export function record(
  ctx: AgentContext,
  rec: Omit<DecisionRecord, "ts" | "agent" | "agentId" | "configHash" | "pipeline" | "prevHash" | "logHash">,
): DecisionRecord {
  mkdirSync(DIR, { recursive: true });
  const s = load(ctx.def.slug);
  const base = {
    ts: new Date().toISOString(),
    agent: ctx.def.slug,
    agentId: ctx.agentId.toString(),
    configHash: ctx.configHash,
    pipeline: ctx.pipeline.id,
    ...rec,
    prevHash: s.hash,
  };
  const logHash = keccak256(toHex(s.hash + JSON.stringify(base)));
  const full: DecisionRecord = { ...base, logHash };
  appendFileSync(file(ctx.def.slug), JSON.stringify(full) + "\n");
  s.hash = logHash;
  s.count += 1;

  if (rec.channel !== "shadow" && ctx.agentId > 0n && s.count % ANCHOR_EVERY === 0) {
    anchorDecision(ctx, logHash, s.count).catch((e) => console.warn(`[${ctx.def.slug}] anchor failed:`, e.message));
  }
  return full;
}

export function readLog(slug: string, limit = 100): DecisionRecord[] {
  if (!existsSync(file(slug))) return [];
  const lines = readFileSync(file(slug), "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as DecisionRecord).reverse();
}

export function inputsHash(x: unknown): Hex {
  return keccak256(toHex(JSON.stringify(x)));
}

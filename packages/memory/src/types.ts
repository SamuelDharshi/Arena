import type { DecisionAction } from "@arena/shared";

export type AttackChannel = "invoice" | "email" | "chat";
export type Outcome = "blocked" | "paid_attacker";
/** short: recent attempts · working: older blocked attempts · long: successful exploits (never expire). */
export type Tier = "short" | "working" | "long";

/** What the keeper hands to remember() after a session settles. */
export interface Attempt {
  sessionId: string;
  agent: string;
  channel: AttackChannel;
  /** Everything the attacker sent in the session, joined. Stored as a short summary, not the whole transcript. */
  payload: string;
  decision: DecisionAction;
  outcome: Outcome;
  validators?: { name: string; passed: boolean; detail: string }[];
  txHash?: string | null;
  /** Unix seconds; defaults to now. */
  ts?: number;
}

export interface MemoryRecord {
  id: string;
  /** Tier at write time. Use tierOf() for the effective tier, which ages short entries into working. */
  tier: Tier;
  confidence: number;
  provenance: { source: "gateway-session"; sessionId: string; txHash: string | null; agent: string };
  channel: AttackChannel;
  summary: string;
  addresses: string[];
  decision: DecisionAction;
  outcome: Outcome;
  validators: { name: string; passed: boolean; detail: string }[];
  createdAt: number;
  /** Audit ledger: each record commits to the one written before it. */
  prevHash: string;
  hash: string;
}

export interface RecallHit {
  id: string;
  similarity: number;
  tier: Tier;
  confidence: number;
  outcome: Outcome;
  agent: string;
  channel: AttackChannel;
  summary: string;
  provenance: MemoryRecord["provenance"];
}

/** A recalled attempt that is a known successful exploit and similar enough to count as a match. */
export const MATCH_THRESHOLD = Number(process.env.MEMORY_MATCH_THRESHOLD || 0.6);

export interface MemoryBackend {
  readonly kind: string;
  remember(attempt: Attempt): Promise<MemoryRecord>;
  recall(item: { subject?: string; body: string; from?: string }, k?: number): Promise<RecallHit[]>;
}

export interface MemoryStore {
  readonly kind: string;
  /** Insert or replace by id. */
  put(rec: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | null>;
  all(): Promise<MemoryRecord[]>;
  /** Hash of the newest record, or the zero hash. */
  head(): Promise<string>;
}

/**
 * Arena Agent Protocol (AAP v0) — the HTTP contract any agent implements to enter the arena.
 * POST {endpoint}/aap/v1/turn
 */

export type InboxItemType = "email" | "invoice" | "chat";

export interface InboxItem {
  id: string;
  type: InboxItemType;
  from: string;
  subject?: string;
  body: string;
  attachments?: { name: string; content: string }[];
}

export interface HistoryEntry {
  role: "attacker" | "agent";
  content: string;
}

export interface TurnRequest {
  sessionId: string;
  mode: "live" | "shadow";
  chainId: number;
  vault: string;
  /** Live: the session attacker's payout address. Shadow: a synthetic address standing in for it. */
  attacker: string;
  inbox: InboxItem[];
  history: HistoryEntry[];
}

export type DecisionAction = "pay" | "hold" | "escalate" | "refuse";

export interface DecisionIntent {
  to: string;
  /** USDC base units (6 decimals) as a decimal string */
  amount: string;
  category: string;
  ref: string;
}

/** One piece of evidence behind a decision. `ledger` is the gateway's own payee lookup (used when Zetaris is not configured). */
export interface DecisionEvidence {
  source: "memory" | "zetaris" | "ledger" | "validator" | "inbox";
  /** Memory id, transaction hash, validator name or inbox item id. */
  ref: string;
  finding: string;
}

export interface Decision {
  action: DecisionAction;
  reasoning: string;
  intent: DecisionIntent | null;
  validators?: { name: string; passed: boolean; detail: string }[];
  /** Present on agents that run DECISION_SCHEMA_V2 (e.g. Sentinel-05). */
  evidence?: DecisionEvidence[];
}

export interface TurnResponse {
  reply: string;
  decision: Decision;
  txHash: string | null;
  /** Machine-readable failure. `LLM_UNAVAILABLE: …` means the agent could not reason and the turn is inconclusive. */
  error?: string;
}

export function isInconclusive(r: TurnResponse): boolean {
  return !!r.error && r.error.startsWith("LLM_UNAVAILABLE");
}

export function isTurnResponse(x: unknown): x is TurnResponse {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  const d = r.decision as Record<string, unknown> | undefined;
  return (
    typeof r.reply === "string" &&
    !!d &&
    typeof d.action === "string" &&
    ["pay", "hold", "escalate", "refuse"].includes(d.action as string) &&
    typeof d.reasoning === "string"
  );
}

export const AAP_LIMITS = {
  maxMessagesPerSession: 30,
  maxMessageBytes: 4096,
  maxLiveSessionsPerAttacker: 5,
} as const;

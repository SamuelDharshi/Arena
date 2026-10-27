"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import type { Decision, InboxItem } from "@arena/shared";
import { GATEWAY } from "./wagmi";

export interface AgentRow {
  id: string;
  owner: Address;
  signer: Address;
  vault: Address;
  config_hash: Hex;
  mandate_hash: Hex | null;
  allowlist_root: Hex | null;
  endpoint: string;
  metadata_uri: string;
  name: string | null;
  description: string | null;
  status: number;
  tier: number;
  effective_tier: number;
  score: number;
  valid_until: string;
  gauntlet_deadline: string;
  daily_limit: string;
  spent_window: string;
  bounty_pool: string;
  locked_bounty: string;
  treasury: string;
  credits: number;
  breaches: number;
  last_breach_at: string | null;
  registered_at: string;
  sessions_survived?: number;
  live_sessions?: number;
  sessions_total?: number;
}

export interface AgentInfo {
  slug: string;
  name: string;
  description: string;
  mandate: string;
  pipeline: { id: string; label: string; validatorRules: string[] };
  signerKind: string;
  vendors: { key: string; name: string; domain: string; category: string; contractMax: string; address: Address }[];
  contextInbox: InboxItem[];
  payables: { id: string; vendorKey: string; amount: string; memo: string }[];
}

export interface AgentDetail extends AgentRow {
  contextInbox: InboxItem[];
  info: AgentInfo | null;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  attacker: Address;
  opener: Address;
  tier: number;
  locked: string;
  fee: string;
  state: number;
  opened_at: string;
  expires_at: string;
  msg_count: number;
  payout: string;
  open_tx: Hex | null;
  breach_tx: Hex | null;
  close_tx: Hex | null;
}

export interface MessageRow {
  id: string;
  seq: number;
  role: "attacker" | "agent" | "system";
  item: InboxItem | null;
  content: string;
  decision: Decision | null;
  tx_hash: Hex | null;
  error: string | null;
  latency_ms: number | null;
  ts: string;
}

export interface ChainSession {
  id: string;
  agentId: string;
  attacker: Address;
  opener: Address;
  tier: number;
  lockedBounty: string;
  fee: string;
  openedAt: string;
  expiresAt: string;
  state: number;
  payout: string;
  msgCount: number;
}

export interface ExploitRow {
  id: string;
  session_id: string;
  victim_agent_id: string;
  victim_name?: string;
  discoverer: Address;
  transcript_hash: Hex;
  transcript_uri: string;
  severity: number;
  bonus: string;
  published_at: string;
  tx: Hex;
  passed?: number;
  failed?: number;
  pending?: number;
}

export interface Metrics {
  agents_registered: number;
  owners: number;
  attackers: number;
  sessions_opened: number;
  sessions_live: number;
  sessions_survived: number;
  breaches: number;
  usdc_at_risk_now: string;
  usdc_locked_now: string;
  usdc_paid_to_attackers: string;
  usdc_fees_collected: string;
  production_usdc_moved: string;
  production_payments: number;
  escalations: number;
  autonomous_payments: number;
  exploits_published: number;
  gauntlet_runs: number;
  external_agents_onboarded: number;
  avg_msgs_per_session: number;
  attack_messages: number;
}

export interface ArenaConfig {
  deployment: {
    chainId: number;
    usdc: Address;
    registry: Address;
    score: Address;
    arena: Address;
    grantPool: Address;
    exploits: Address;
    factory: Address;
    admin: Address;
    demoFastTiers: boolean;
  };
  tierBounty: string[];
  tierFee: string[];
  sessionTTL: string;
  gates: { minSessions: number; minDistinct: number; minScore: number }[];
  fullEffortMsgs: number;
  minCountedMsgs: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { token?: string | null }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body) headers["Content-Type"] = "application/json";
  if (init?.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

const live = { refetchInterval: 5000, staleTime: 2000 } as const;

export const useAgents = () => useQuery({ queryKey: ["agents"], queryFn: () => api<AgentRow[]>("/v1/agents"), ...live });
export const useAgent = (id: string) => useQuery({ queryKey: ["agent", id], queryFn: () => api<AgentDetail>(`/v1/agents/${id}`), ...live });
export const useMetrics = () => useQuery({ queryKey: ["metrics"], queryFn: () => api<Metrics>("/v1/metrics"), ...live });
export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => api<ArenaConfig>("/v1/config"), staleTime: 60_000 });
export const useExploits = () => useQuery({ queryKey: ["exploits"], queryFn: () => api<ExploitRow[]>("/v1/exploits"), ...live });
export const useStanding = (id: string) =>
  useQuery({ queryKey: ["standing", id], queryFn: () => api<{ tier: number; score: number; ts: string; tx: Hex }[]>(`/v1/agents/${id}/standing`), ...live });
export const useAgentSessions = (id: string) =>
  useQuery({ queryKey: ["agent-sessions", id], queryFn: () => api<SessionRow[]>(`/v1/agents/${id}/sessions`), ...live });
export const useAgentPayments = (id: string) =>
  useQuery({
    queryKey: ["payments", id],
    queryFn: () => api<{ id: string; kind: string; to_addr: Address; amount: string; escalated: boolean; tx: Hex; ts: string }[]>(`/v1/agents/${id}/payments`),
    ...live,
  });
export const useGauntlet = (id: string) =>
  useQuery({ queryKey: ["gauntlet", id], queryFn: () => api<{ exploit_id: string; result: string; tx: Hex | null }[]>(`/v1/agents/${id}/gauntlet`), ...live });
export const useDecisions = (id: string) =>
  useQuery({
    queryKey: ["decisions", id],
    queryFn: () =>
      api<
        {
          ts: string;
          channel: string;
          action: string;
          reasoning: string;
          intent: Decision["intent"];
          validators: Decision["validators"];
          evidence?: Decision["evidence"];
          txHash: string | null;
          error?: string;
          logHash: string;
          pipeline: string;
        }[]
      >(`/v1/agents/${id}/decisions`),
    refetchInterval: 8000,
  });
export const useAttackerBoard = () =>
  useQuery({
    queryKey: ["attackers"],
    queryFn: () => api<{ attacker: Address; sessions: number; breaches: number; earned: string }[]>("/v1/leaderboard/attackers"),
    ...live,
  });

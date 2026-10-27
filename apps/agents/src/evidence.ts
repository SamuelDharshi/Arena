/**
 * Payee evidence: what the arena already knows about a payout address (past payments, attacker payouts, registry match,
 * latest invoice). One federated query answers it.
 *
 *   ZETARIS_API_KEY and ZETARIS_ORG_ID set → the query runs on Zetaris across the registered sources (chain events, Postgres, vendor registry).
 *   otherwise        → the gateway runs the same lookup on its own Postgres (labelled "ledger" in every log line).
 *   neither          → "unavailable": the decision is made without it and never pays more than it would have.
 */
import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { formatUsdc, ledgerFromKindRows, payeeSqlFederated, toLedgerRow, type DecisionEvidence, type PayeeLedgerRow } from "@arena/shared";
import { findVendor, PAYABLES, vendors, type Vendor } from "./fixtures";

export interface PayeeEvidence {
  source: "zetaris" | "ledger";
  address: string;
  pastPayments: { count: number; totalUsdc: string; firstSeen: number | null };
  /** Breached sessions whose payout went to this address. */
  attackerPayoutSessions: string[];
  /** Registry vendor that owns this address, if any. */
  registryVendor: string | null;
  /** Whether the address is the registry payout address of the vendor named on the invoice (null when no vendor is named). */
  matchesRegistry: boolean | null;
  latestInvoiceRef: string | null;
}

export type EvidenceResult = { ok: true; ev: PayeeEvidence } | { ok: false; reason: string };

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; row: Promise<{ source: "zetaris" | "ledger"; row: PayeeLedgerRow }> }>();
let testFetch: ((address: string) => Promise<{ source: "zetaris" | "ledger"; row: PayeeLedgerRow }>) | null = null;
export function __setEvidenceFetchForTest(fn: typeof testFetch) {
  testFetch = fn;
  cache.clear();
}

const gatewayBase = () => process.env.MEMORY_URL || process.env.GATEWAY_PUBLIC_URL;

export const zetarisConfigured = () => !!(process.env.ZETARIS_API_KEY && process.env.ZETARIS_ORG_ID);
const ZETARIS_BASE = () => (process.env.ZETARIS_BASE_URL || "https://api.saas.enterprise.zetaris.com").replace(/\/$/, "");

/**
 * Runs the federated payee query through Zetaris's SQL Query API (https://api.saas.enterprise.zetaris.com/redoc):
 *   POST   /api/v1.0/query/sql/start            { select, pageLimit }  → { records, queryToken, totalPages }
 *   GET    /api/v1.0/query/sql/page             ?queryToken&pageLimit&pageNumber  (further pages)
 *   DELETE /api/v1.0/query/sql/close/{token}    always, so the query does not stay open
 * Every call carries the API key as the Bearer token plus X-Org-ID and a fresh X-Request-ID. The login endpoint is not
 * needed for SQL queries.
 */
export async function zetarisRow(address: string): Promise<PayeeLedgerRow> {
  const headers = () => ({
    Authorization: `Bearer ${process.env.ZETARIS_API_KEY}`,
    "X-Org-ID": process.env.ZETARIS_ORG_ID!,
    "X-Request-ID": randomUUID(),
    accept: "application/json",
  });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${ZETARIS_BASE()}${path}`, {
      ...init,
      headers: { ...headers(), ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 240);
      throw new Error(`Zetaris ${init.method ?? "GET"} ${path.split("?")[0]} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res;
  };
  const PAGE = 100;
  const first = (await (await call("/api/v1.0/query/sql/start", { method: "POST", body: JSON.stringify({ select: payeeSqlFederated(address), pageLimit: PAGE }) })).json()) as {
    records?: Record<string, unknown>[];
    queryToken: string;
    totalPages?: number;
  };
  try {
    const rows = [...(first.records ?? [])];
    for (let page = 2; page <= Math.min(first.totalPages ?? 1, 5); page++) {
      const next = (await (await call(`/api/v1.0/query/sql/page?queryToken=${encodeURIComponent(first.queryToken)}&pageLimit=${PAGE}&pageNumber=${page}`)).json()) as { records?: Record<string, unknown>[] };
      rows.push(...(next.records ?? []));
    }
    return ledgerFromKindRows(rows);
  } finally {
    await call(`/api/v1.0/query/sql/close/${encodeURIComponent(first.queryToken)}`, { method: "DELETE" }).catch(() => undefined);
  }
}

async function gatewayRow(address: string): Promise<PayeeLedgerRow> {
  const base = gatewayBase();
  if (!base) throw new Error("no evidence backend configured (set ZETARIS_API_KEY + ZETARIS_ORG_ID, or MEMORY_URL)");
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/evidence/payee/${address}`, {
    headers: process.env.MEMORY_TOKEN ? { authorization: `Bearer ${process.env.MEMORY_TOKEN}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`gateway evidence HTTP ${res.status}`);
  return toLedgerRow((await res.json()) as Record<string, unknown>);
}

function fetchRow(address: string): Promise<{ source: "zetaris" | "ledger"; row: PayeeLedgerRow }> {
  if (testFetch) return testFetch(address);
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const row = (async () => {
    if (zetarisConfigured()) {
      try {
        return { source: "zetaris" as const, row: await zetarisRow(address) };
      } catch (err) {
        console.warn(`[evidence] Zetaris failed, falling back to the gateway ledger: ${(err as Error).message}`);
      }
    }
    return { source: "ledger" as const, row: await gatewayRow(address) };
  })();
  cache.set(address, { at: Date.now(), row });
  row.catch(() => cache.delete(address));
  return row;
}

/** Evidence for paying `address` on an invoice from `vendorName` (empty when no vendor is named). Never throws. */
export async function vendorEvidence(vendorName: string, address: string): Promise<EvidenceResult> {
  if (!isAddress(address)) return { ok: false, reason: "not an address" };
  const addr = getAddress(address);
  try {
    const { source, row } = await fetchRow(addr);
    const vendor: Vendor | undefined = vendorName ? findVendor(vendorName) : undefined;
    const owner = vendors().find((v) => v.address.toLowerCase() === addr.toLowerCase());
    const latestPayable = vendor ? [...PAYABLES].reverse().find((p) => p.vendorKey === vendor.key) : undefined;
    return {
      ok: true,
      ev: {
        source,
        address: addr,
        pastPayments: { count: row.payments_count, totalUsdc: formatUsdc(BigInt(row.payments_total.split(".")[0] || "0")), firstSeen: row.first_seen },
        attackerPayoutSessions: row.attacker_sessions,
        registryVendor: owner?.name ?? row.registry_vendor ?? null,
        matchesRegistry: vendor ? vendor.address.toLowerCase() === addr.toLowerCase() : null,
        latestInvoiceRef: latestPayable?.id ?? row.latest_ref,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[evidence] unavailable for ${addr}: ${reason}`);
    return { ok: false, reason };
  }
}

export function describe(ev: PayeeEvidence): string {
  const parts = [
    ev.pastPayments.count ? `${ev.pastPayments.count} past payment(s), ${ev.pastPayments.totalUsdc} total` : "never paid before",
    ev.attackerPayoutSessions.length ? `RECEIVED AN ATTACKER PAYOUT (session ${ev.attackerPayoutSessions.map((s) => "#" + s).join(", ")})` : "no attacker payout on record",
    ev.registryVendor ? `registry payout address of ${ev.registryVendor}` : "not a registry address",
  ];
  if (ev.matchesRegistry === false) parts.push("does NOT match the named vendor's registry address");
  if (ev.latestInvoiceRef) parts.push(`latest invoice ref ${ev.latestInvoiceRef}`);
  return parts.join(" · ");
}

export function evidenceRow(ev: PayeeEvidence): DecisionEvidence {
  return { source: ev.source, ref: ev.address, finding: describe(ev) };
}

export function payeeBlock(evs: PayeeEvidence[]): string {
  if (!evs.length) return "";
  const rows = evs.map((e) => `  <payee address="${e.address}" source="${e.source}">${describe(e)}</payee>`);
  return `<payee_evidence>\n${rows.join("\n")}\n</payee_evidence>`;
}

/** The validator entry for paying this address. Blocks only on a recorded attacker payout (registry rules block the rest). */
export function payeeValidator(r: EvidenceResult): { name: string; passed: boolean; detail: string } {
  if (!r.ok) return { name: "payee_history_unavailable", passed: true, detail: `evidence backend unavailable (${r.reason}); other validators still apply` };
  const blocked = r.ev.attackerPayoutSessions.length > 0;
  return {
    name: r.ev.source === "zetaris" ? "zetaris_payee_history" : "ledger_payee_history",
    passed: !blocked,
    detail: describe(r.ev),
  };
}

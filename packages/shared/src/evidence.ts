/**
 * Payee evidence: what the arena already knows about a payout address, as ONE query.
 *
 * The facts live in different places: payment events indexed from the chain, attack sessions in Postgres, and the vendor
 * registry. The same logical query runs in two places:
 *   - Zetaris (federated: the three sources are registered as arena_chain, arena_pg and arena_registry), or
 *   - the gateway's own Postgres (the two database-backed sources; the registry is compared in the agent).
 */
import { isAddress } from "viem";

/** One row of facts about an address. Amounts are USDC base units (6 decimals) as strings. */
export interface PayeeLedgerRow {
  payments_count: number;
  payments_total: string;
  first_seen: number | null;
  /** Ids of breached sessions whose payout went to this address. */
  attacker_sessions: string[];
  latest_ref: string | null;
  /** Only the federated query joins the registry source. */
  registry_vendor?: string | null;
}

/** The addresses are hex-only after this check, so inlining them into SQL text cannot inject anything. */
function lit(address: string): string {
  if (!isAddress(address)) throw new Error("not an address");
  return `lower('${address}')`;
}

/** Runs on the gateway's Postgres (tables payments and sessions). */
export function payeeSqlLocal(address: string): string {
  const a = lit(address);
  return `SELECT
  (SELECT COUNT(*)::int FROM payments WHERE lower(to_addr) = ${a}) AS payments_count,
  (SELECT COALESCE(SUM(amount), 0)::text FROM payments WHERE lower(to_addr) = ${a}) AS payments_total,
  (SELECT MIN(ts)::bigint FROM payments WHERE lower(to_addr) = ${a}) AS first_seen,
  (SELECT COALESCE(json_agg(id::text), '[]'::json) FROM sessions WHERE state = 2 AND lower(attacker) = ${a}) AS attacker_sessions,
  (SELECT ref FROM payments WHERE lower(to_addr) = ${a} ORDER BY ts DESC LIMIT 1) AS latest_ref`;
}

/**
 * The federated form for Zetaris: ONE query across the three registered sources (chain events, Postgres, vendor
 * registry). It sticks to portable SQL (UNION ALL, COUNT, SUM, MIN, CAST) because the dialect behind Zetaris is not
 * ours to assume. Each row carries a `kind`; read them back with ledgerFromKindRows().
 *   payments         a = count, b = total (USDC base units), c = first seen (unix seconds)
 *   attacker_session a = id of a breached session whose payout went to this address
 *   latest_ref       a = the most recent invoice ref paid to this address
 *   registry_vendor  a = the registry vendor that owns this address
 * The source names are databases in your Zetaris workspace (ZETARIS_SCHEMA_PG / _CHAIN / _REGISTRY).
 */
export function payeeSqlFederated(address: string, names = zetarisSchemas()): string {
  const a = lit(address);
  const { pg, chain, registry } = names;
  return `SELECT 'payments' AS kind, CAST(COUNT(*) AS STRING) AS a, CAST(COALESCE(SUM(amount), 0) AS STRING) AS b, CAST(MIN(ts) AS STRING) AS c
  FROM ${chain}.payments WHERE lower(to_addr) = ${a}
UNION ALL
SELECT 'attacker_session', CAST(id AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING)
  FROM ${pg}.sessions WHERE state = 2 AND lower(attacker) = ${a}
UNION ALL
SELECT 'latest_ref', CAST(ref AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING)
  FROM (SELECT ref FROM ${chain}.payments WHERE lower(to_addr) = ${a} ORDER BY ts DESC LIMIT 1) latest
UNION ALL
SELECT 'registry_vendor', CAST(name AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING)
  FROM ${registry}.vendors WHERE lower(payout_address) = ${a}`;
}

/** Folds the `kind` rows of payeeSqlFederated() into one PayeeLedgerRow. Column names are matched case-insensitively. */
export function ledgerFromKindRows(rows: Record<string, unknown>[]): PayeeLedgerRow {
  const out: PayeeLedgerRow = { payments_count: 0, payments_total: "0", first_seen: null, attacker_sessions: [], latest_ref: null, registry_vendor: null };
  for (const raw of rows) {
    const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, unknown>;
    const val = (k: string) => (r[k] == null || r[k] === "" ? null : String(r[k]));
    switch (String(r.kind)) {
      case "payments":
        out.payments_count = Number(val("a") ?? 0);
        out.payments_total = (val("b") ?? "0").split(".")[0];
        out.first_seen = val("c") == null ? null : Number(val("c"));
        break;
      case "attacker_session":
        if (val("a")) out.attacker_sessions.push(val("a")!);
        break;
      case "latest_ref":
        out.latest_ref = val("a");
        break;
      case "registry_vendor":
        out.registry_vendor = val("a");
        break;
    }
  }
  return out;
}

export function zetarisSchemas() {
  return {
    pg: process.env.ZETARIS_SCHEMA_PG || "arena_pg",
    chain: process.env.ZETARIS_SCHEMA_CHAIN || "arena_chain",
    registry: process.env.ZETARIS_SCHEMA_REGISTRY || "arena_registry",
  };
}

/** Normalises a row from either backend (Zetaris may return numbers as strings and JSON as text). */
export function toLedgerRow(raw: Record<string, unknown>): PayeeLedgerRow {
  const sessions = raw.attacker_sessions;
  let list: string[] = [];
  if (Array.isArray(sessions)) list = sessions.map(String);
  else if (typeof sessions === "string" && sessions.trim().startsWith("[")) {
    try {
      list = (JSON.parse(sessions) as unknown[]).map(String);
    } catch {
      list = [];
    }
  }
  return {
    payments_count: Number(raw.payments_count ?? 0),
    payments_total: String(raw.payments_total ?? "0"),
    first_seen: raw.first_seen == null ? null : Number(raw.first_seen),
    attacker_sessions: list,
    latest_ref: raw.latest_ref == null ? null : String(raw.latest_ref),
    registry_vendor: raw.registry_vendor == null ? null : String(raw.registry_vendor),
  };
}

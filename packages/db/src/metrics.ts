import type { Db } from "./index";

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
  updated_at: number;
}

/** Traction counters (PRD §12.1), computed from indexed on-chain state. */
export async function computeMetrics(db: Db, protocolAdmin?: string): Promise<Metrics> {
  const q = async (sql: string, params: unknown[] = []) => (await db.one<Record<string, unknown>>(sql, params)) ?? {};
  const now = Math.floor(Date.now() / 1000);
  const [a, s, p, e, g, m] = await Promise.all([
    q(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT owner)::int AS owners,
              COALESCE(SUM(CASE WHEN status = 1 THEN bounty_pool ELSE 0 END),0)::text AS at_risk,
              COALESCE(SUM(locked_bounty),0)::text AS locked,
              COUNT(*) FILTER (WHERE lower(owner) <> lower($1))::int AS external
         FROM agents`,
      [protocolAdmin ?? ""],
    ),
    q(
      `SELECT COUNT(*)::int AS opened,
              COUNT(*) FILTER (WHERE state = 1 AND expires_at > $1)::int AS live,
              COUNT(*) FILTER (WHERE state = 3)::int AS survived,
              COUNT(*) FILTER (WHERE state = 2)::int AS breaches,
              COUNT(DISTINCT attacker)::int AS attackers,
              COALESCE(SUM(payout),0)::text AS paid,
              COALESCE(SUM(CASE WHEN state = 3 THEN fee ELSE 0 END),0)::text AS fees,
              COALESCE(AVG(NULLIF(msg_count,0)),0)::float AS avg_msgs
         FROM sessions`,
      [now],
    ),
    q(
      `SELECT COALESCE(SUM(amount),0)::text AS moved, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE escalated)::int AS escalated
         FROM payments WHERE kind = 'production'`,
    ),
    q(`SELECT COUNT(*)::int AS n FROM exploits`),
    q(`SELECT COUNT(*)::int AS n FROM gauntlet_runs`),
    q(`SELECT COUNT(*)::int AS n FROM messages WHERE role = 'attacker'`),
  ]);
  return {
    agents_registered: Number(a.n ?? 0),
    owners: Number(a.owners ?? 0),
    attackers: Number(s.attackers ?? 0),
    sessions_opened: Number(s.opened ?? 0),
    sessions_live: Number(s.live ?? 0),
    sessions_survived: Number(s.survived ?? 0),
    breaches: Number(s.breaches ?? 0),
    usdc_at_risk_now: String(a.at_risk ?? "0"),
    usdc_locked_now: String(a.locked ?? "0"),
    usdc_paid_to_attackers: String(s.paid ?? "0"),
    usdc_fees_collected: String(s.fees ?? "0"),
    production_usdc_moved: String(p.moved ?? "0"),
    production_payments: Number(p.n ?? 0),
    escalations: Number(p.escalated ?? 0),
    autonomous_payments: Number(p.n ?? 0) - Number(p.escalated ?? 0),
    exploits_published: Number(e.n ?? 0),
    gauntlet_runs: Number(g.n ?? 0),
    external_agents_onboarded: Number(a.external ?? 0),
    avg_msgs_per_session: Math.round(Number(s.avg_msgs ?? 0) * 10) / 10,
    attack_messages: Number(m.n ?? 0),
    updated_at: now,
  };
}

export async function rollupMetrics(db: Db, protocolAdmin?: string): Promise<Metrics> {
  const m = await computeMetrics(db, protocolAdmin);
  const ts = Math.floor(Date.now() / 1000);
  for (const [k, v] of Object.entries(m)) {
    if (k === "updated_at") continue;
    await db.query(
      `INSERT INTO metrics(key, value, ts) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, ts = EXCLUDED.ts`,
      [k, String(v), ts],
    );
  }
  return m;
}

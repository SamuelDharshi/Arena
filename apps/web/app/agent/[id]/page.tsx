"use client";
import Link from "next/link";
import { useState } from "react";
import { formatUsdc } from "@arena/shared";
import { useAgent, useAgentPayments, useAgentSessions, useDecisions, useGauntlet, useStanding } from "@/lib/api";
import { AddrLink, Empty, ScoreGauge, Stat, STATE_COLOR, STATE_LABEL, TierBadge, timeAgo, TxLink, Usdc } from "@/components/ui";
import { StandingChart } from "@/components/StandingChart";

const ACTION_COLOR: Record<string, string> = { pay: "#ff3b4d", hold: "#18181b", escalate: "#ff4fd8", refuse: "#000000" };

export default function AgentPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { data: a, error } = useAgent(id);
  const { data: standing } = useStanding(id);
  const { data: sessions } = useAgentSessions(id);
  const { data: payments } = useAgentPayments(id);
  const { data: gauntlet } = useGauntlet(id);
  const { data: decisions } = useDecisions(id);
  const [tab, setTab] = useState<"sessions" | "decisions" | "payments" | "gauntlet">("sessions");

  if (error) return <div className="pt-8"><Empty>{(error as Error).message}</Empty></div>;
  if (!a) return <div className="pt-8"><Empty>Loading agent…</Empty></div>;

  const free = BigInt(a.bounty_pool) - BigInt(a.locked_bounty);
  const gauntletDeadline = Number(a.gauntlet_deadline);

  return (
    <div className="space-y-6 pt-6">
      <div className="flex flex-wrap items-start gap-5">
        <ScoreGauge score={a.score} tier={a.effective_tier} size={92} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold">{a.name ?? `Agent #${a.id}`}</h1>
            <TierBadge tier={a.effective_tier} status={a.status} />
            {a.info?.pipeline && <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">{a.info.pipeline.label}</span>}
          </div>
          <p className="mt-1 max-w-2xl text-slate-400">{a.description}</p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
            <span>owner <AddrLink addr={a.owner} /></span>
            <span>signer <AddrLink addr={a.signer} />{a.info?.signerKind === "circle-wallet" && " (Circle Wallet)"}</span>
            <span>vault <AddrLink addr={a.vault} /></span>
            <span className="font-mono" title={a.config_hash}>configHash {a.config_hash.slice(0, 10)}…</span>
          </div>
        </div>
        <Link href={`/attack/${a.id}`} className={a.status === 1 ? "btn-danger" : "btn-ghost pointer-events-none opacity-40"}>
          {a.status === 1 ? `Attack — up to ${formatUsdc(free)} at risk` : a.status === 2 ? "Breached — awaiting patch" : "Suspended — awaiting patch"}
        </Link>
      </div>

      {gauntletDeadline > 0 && (
        <div className="rounded-lg border border-[#ff4fd8]/40 bg-accent/10 px-4 py-2 text-sm text-black">
          Unresolved Gauntlet exploit — this agent must pass the replay by {new Date(gauntletDeadline * 1000).toLocaleString()} or its tier drops to T0.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Bounty at risk" value={<Usdc v={free} />} accent="#18181b" />
        <Stat label="Locked in sessions" value={<Usdc v={a.locked_bounty} />} />
        <Stat label="Autonomous daily limit" value={<Usdc v={a.daily_limit} />} accent="#000000" />
        <Stat label="Spent (24h window)" value={<Usdc v={a.spent_window} />} />
        <Stat label="Treasury" value={<Usdc v={a.treasury} />} />
        <Stat label="Credits / breaches" value={<span className="num">{a.credits} / <span className="text-breach">{a.breaches}</span></span>} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section className="panel p-4">
          <h2 className="panel-title mb-2">Standing timeline (StandingUpdated events)</h2>
          <StandingChart points={(standing ?? []).map((s) => ({ score: s.score, tier: s.tier, ts: s.ts }))} />
          <p className="mt-2 text-xs text-ink-500">
            Spending limit = bounty proven defensible. Tier decays after 7 days without fresh credit, resets on any config change, and drops to T0 on breach.
          </p>
        </section>
        <section className="panel p-4">
          <h2 className="panel-title mb-2">Public mandate</h2>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">{a.info?.mandate ?? "Mandate not published by this agent."}</pre>
          {a.mandate_hash && <div className="mt-2 truncate font-mono text-[10px] text-ink-500">mandateHash {a.mandate_hash}</div>}
          {a.info?.pipeline?.validatorRules?.length ? (
            <>
              <h3 className="panel-title mb-1 mt-3">Validators</h3>
              <ul className="space-y-0.5 text-xs text-slate-400">
                {a.info.pipeline.validatorRules.map((r) => <li key={r}>• {r}</li>)}
              </ul>
            </>
          ) : null}
        </section>
      </div>

      <section className="panel">
        <div className="flex gap-1 border-b border-ink-700 px-2 pt-2">
          {(["sessions", "decisions", "payments", "gauntlet"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-t-md px-3 py-2 text-sm capitalize ${tab === t ? "bg-ink-800 text-fg" : "text-slate-400 hover:text-fg"}`}>
              {t === "decisions" ? "Decision log" : t === "gauntlet" ? "Gauntlet matrix" : t}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto p-3">
          {tab === "sessions" && (
            sessions?.length ? (
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left font-mono text-[11px] uppercase text-ink-500">
                  <tr><th className="p-2">#</th><th className="p-2">Attacker</th><th className="p-2">Tier</th><th className="p-2">State</th><th className="p-2 text-right">Msgs</th><th className="p-2 text-right">Payout</th><th className="p-2">Opened</th><th className="p-2">Tx</th></tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-t border-ink-800">
                      <td className="p-2 font-mono">{s.id}</td>
                      <td className="p-2"><AddrLink addr={s.attacker} /></td>
                      <td className="p-2"><TierBadge tier={s.tier} /></td>
                      <td className="p-2 font-mono text-xs" style={{ color: STATE_COLOR[s.state] }}>{STATE_LABEL[s.state]}</td>
                      <td className="p-2 text-right num">{s.msg_count}</td>
                      <td className="p-2 text-right"><Usdc v={s.payout} /></td>
                      <td className="p-2 text-xs text-slate-400">{timeAgo(s.opened_at)}</td>
                      <td className="p-2"><TxLink hash={s.breach_tx ?? s.close_tx ?? s.open_tx} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No sessions yet.</Empty>
          )}
          {tab === "decisions" && (
            decisions?.length ? (
              <ul className="space-y-2">
                {decisions.map((d) => (
                  <li key={d.logHash} className="rounded-lg border border-ink-700 bg-ink-950/60 p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded px-1.5 py-0.5 font-mono font-bold uppercase text-ink-950" style={{ background: ACTION_COLOR[d.action] ?? "#7c8499" }}>{d.action}</span>
                      <span className="font-mono text-ink-500">{d.channel} · {d.pipeline} · {new Date(d.ts).toLocaleString()}</span>
                      {d.txHash && <TxLink hash={d.txHash} />}
                      {d.error && <span className="font-mono text-breach">{d.error}</span>}
                      <span className="ml-auto font-mono text-[10px] text-ink-500" title={d.logHash}>log {d.logHash.slice(0, 10)}…</span>
                    </div>
                    <p className="mt-1.5 text-slate-300">{d.reasoning}</p>
                    {d.validators?.length ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {d.validators.map((v) => (
                          <span key={v.name} title={v.detail} className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${v.passed ? "bg-[#000000]/10 text-accent" : "bg-breach/15 text-breach"}`}>
                            {v.passed ? "✓" : "✗"} {v.name}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : <Empty>No decisions logged (the decision log is served by the agent runtime).</Empty>
          )}
          {tab === "payments" && (
            payments?.length ? (
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left font-mono text-[11px] uppercase text-ink-500">
                  <tr><th className="p-2">Kind</th><th className="p-2">To</th><th className="p-2 text-right">Amount</th><th className="p-2">Escalated</th><th className="p-2">When</th><th className="p-2">Tx</th></tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-t border-ink-800">
                      <td className="p-2 font-mono text-xs">{p.kind}</td>
                      <td className="p-2"><AddrLink addr={p.to_addr} /></td>
                      <td className="p-2 text-right"><Usdc v={p.amount} /></td>
                      <td className="p-2 text-xs">{p.escalated ? <span className="text-accent">owner co-signed</span> : "autonomous"}</td>
                      <td className="p-2 text-xs text-slate-400">{timeAgo(p.ts)}</td>
                      <td className="p-2"><TxLink hash={p.tx} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No payments yet.</Empty>
          )}
          {tab === "gauntlet" && (
            gauntlet?.length ? (
              <div className="flex flex-wrap gap-2">
                {gauntlet.map((g) => (
                  <Link key={g.exploit_id} href={`/exploits/${g.exploit_id}`} className="rounded-lg border border-ink-700 px-3 py-2 text-sm hover:border-slate-400">
                    Exploit #{g.exploit_id}{" "}
                    <span className={g.result === "passed" ? "text-accent" : g.result === "failed" ? "text-breach" : "text-accent"}>
                      {g.result === "passed" ? "✅ survives" : g.result === "failed" ? "❌ vulnerable" : "⏳ pending"}
                    </span>
                  </Link>
                ))}
              </div>
            ) : <Empty>No exploits replayed against this agent yet.</Empty>
          )}
        </div>
      </section>
    </div>
  );
}

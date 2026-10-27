"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatUsdc } from "@arena/shared";
import { ArenaStage } from "@/components/arena/Stage";
import type { ArenaPulse } from "@/components/arena/ArenaScene";
import { useRouter } from "next/navigation";
import { api, useAgents, useAttackerBoard, useMetrics } from "@/lib/api";
import { useEventStream } from "@/lib/sse";
import { AddrLink, Empty, ScoreGauge, TierBadge, timeAgo, TxLink, Usdc } from "@/components/ui";

interface FeedItem {
  key: string;
  text: string;
  color: string;
  tx?: string;
}

const EVENT_TEXT: Record<string, (a: Record<string, string>) => [string, string] | null> = {
  SessionOpened: (a) => [`⚔ Attacker opened a T${a.tier} session on agent #${a.agentId}`, "#ff6a1a"],
  Breach: (a) => [`💥 Agent #${a.agentId} BREACHED — ${formatUsdc(BigInt(a.payout))} paid out automatically`, "#ff3b1d"],
  SessionSurvived: (a) => [`🛡 Agent #${a.agentId} survived session #${a.sid} (${a.msgCount} msgs)`, "#ff6a1a"],
  StandingUpdated: (a) => [`▲ Agent #${a.agentId} standing → T${a.tier} · score ${a.score}`, "#ff8a3d"],
  ExploitPublished: (a) => [`☣ Exploit #${a.exploitId} published — Gauntlet replay started`, "#ff6a1a"],
  GauntletResult: (a) => [`${a.passed ? "✅" : "❌"} Agent #${a.agentId} ${a.passed ? "passed" : "failed"} exploit #${a.exploitId}`, a.passed ? "#ff6a1a" : "#ff3b1d"],
  ProductionPayment: (a) => [`$ Agent #${a.agentId} paid a vendor ${formatUsdc(BigInt(a.amount))}${a.escalated ? " (owner co-signed)" : ""}`, "#ffedd5"],
  AgentRegistered: (a) => [`+ Agent #${a.agentId} entered the arena`, "#ff6a1a"],
};

interface ChainEvent {
  id: string;
  name: string;
  args: Record<string, string>;
  tx: string;
  agent_id: string | null;
}

function toFeed(ev: ChainEvent): FeedItem | null {
  const fmt = EVENT_TEXT[ev.name]?.(ev.args);
  return fmt ? { key: ev.id, text: fmt[0], color: fmt[1], tx: ev.tx } : null;
}

export default function ArenaPage() {
  const router = useRouter();
  const { data: agents, isLoading, error } = useAgents();
  const { data: m } = useMetrics();
  const { data: attackers } = useAttackerBoard();
  const [pulses, setPulses] = useState<ArenaPulse[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);

  // Backfill the feed with recent indexed events, then stream new ones.
  useEffect(() => {
    api<ChainEvent[]>("/v1/events?limit=40")
      .then((evs) =>
        setFeed((f) => {
          const seen = new Set(f.map((x) => x.key));
          const back = evs.map(toFeed).filter((x): x is FeedItem => !!x && !seen.has(x.key));
          return [...f, ...back].slice(0, 30);
        }),
      )
      .catch(() => undefined);
  }, []);

  useEventStream("/v1/stream", (e) => {
    if (e.type !== "chain") return;
    const ev = e.event as ChainEvent;
    const item = toFeed(ev);
    if (item) setFeed((f) => (f.some((x) => x.key === item.key) ? f : [item, ...f].slice(0, 30)));
    const kind = ev.name === "Breach" ? "breach" : ev.name === "SessionSurvived" ? "survived" : ev.name === "SessionOpened" ? "session" : null;
    if (kind && ev.agent_id) setPulses((p) => [...p.slice(-20), { key: Date.now(), agentId: ev.agent_id!, kind }]);
  });

  const arenaAgents = useMemo(
    () =>
      (agents ?? []).map((a) => ({
        id: a.id,
        name: a.name ?? `Agent #${a.id}`,
        tier: a.effective_tier,
        score: a.score,
        status: a.status,
        bounty: Number(a.bounty_pool) / 1e6,
        live: a.live_sessions ?? 0,
      })),
    [agents],
  );

  return (
    <div className="space-y-6 pt-4">
      {/* Hero: the colosseum */}
      <section className="theme-dark relative overflow-hidden text-[#ffedd5]">
        {/* Phones: text, arena and stats stack. ≥sm: text and stats overlay the arena. */}
        <div className="relative z-20 p-5 sm:pointer-events-none sm:absolute sm:inset-x-0 sm:top-0 sm:p-7">
          <h1 className="max-w-xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
            Break the agent. <span className="text-[#ff6a1a]">Keep the bounty.</span>
          </h1>
          <p className="mt-3 max-w-lg text-sm text-slate-300 sm:text-base">
            Every champion holds real USDC in a policy-enforced wallet. Trick one into paying you and the contract pays the bounty — no judge.
            Fail, and its on-chain score and spending limit go up.
          </p>
        </div>
        <ArenaStage className="h-[320px] w-full sm:h-[56vh] sm:min-h-[380px]" agents={arenaAgents} pulses={pulses} onSelect={(id) => router.push(`/agent/${id}`)} />
        <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-2/3 bg-gradient-to-r from-ink-950/85 via-ink-950/30 to-transparent sm:block" />
        <div className="relative z-10 grid grid-cols-2 gap-2 p-4 sm:pointer-events-none sm:absolute sm:inset-x-0 sm:bottom-0 sm:flex sm:flex-wrap sm:p-6">
          {[
            ["At risk now", m ? formatUsdc(BigInt(m.usdc_at_risk_now)) : "…", "#ff6a1a"],
            ["Paid to attackers", m ? formatUsdc(BigInt(m.usdc_paid_to_attackers)) : "…", "#ff6a1a"],
            ["Live sessions", m?.sessions_live ?? "…", "#ff6a1a"],
            ["Survived", m?.sessions_survived ?? "…", "#ff6a1a"],
          ].map(([l, v, c]) => (
            <div key={l as string} className="rounded-lg border border-ink-600/80 bg-ink-950/70 px-3 py-2 backdrop-blur">
              <div className="panel-title">{l}</div>
              <div className="num text-lg font-bold" style={{ color: c as string }}>{v}</div>
            </div>
          ))}
          <span className="col-span-2 self-end font-mono text-[10px] text-ink-500 sm:ml-auto">drag to orbit · click a champion</span>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Leaderboard */}
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
            <h2 className="panel-title">Leaderboard · ranked by proven tier & on-chain score</h2>
          </div>
          {error ? (
            <div className="p-4"><Empty>Gateway unreachable: {(error as Error).message}</Empty></div>
          ) : isLoading ? (
            <div className="p-4"><Empty>Loading agents…</Empty></div>
          ) : !agents?.length ? (
            <div className="p-4"><Empty>No agents registered yet.</Empty></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-left font-mono text-[11px] uppercase tracking-wider text-ink-500">
                  <tr>
                    <th className="px-4 py-2">Agent</th>
                    <th className="px-2 py-2">Score</th>
                    <th className="px-2 py-2">Tier</th>
                    <th className="px-2 py-2 text-right">Bounty at risk</th>
                    <th className="px-2 py-2 text-right">Daily limit</th>
                    <th className="px-2 py-2 text-right">Survived</th>
                    <th className="px-2 py-2">Last breach</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a, i) => (
                    <tr key={a.id} className="animate-rise border-t border-ink-800 hover:bg-ink-800/50" style={{ animationDelay: `${i * 40}ms` }}>
                      <td className="px-4 py-3">
                        <Link href={`/agent/${a.id}`} className="font-semibold hover:text-accent">{a.name ?? `Agent #${a.id}`}</Link>
                        <div className="max-w-[280px] truncate text-xs text-ink-500">{a.description}</div>
                      </td>
                      <td className="px-2 py-3"><ScoreGauge score={a.score} tier={a.effective_tier} size={44} /></td>
                      <td className="px-2 py-3"><TierBadge tier={a.effective_tier} status={a.status} /></td>
                      <td className="px-2 py-3 text-right">
                        <Usdc v={BigInt(a.bounty_pool) - BigInt(a.locked_bounty)} className="text-[#18181b]" />
                        {BigInt(a.locked_bounty) > 0n && <div className="text-[11px] text-ink-500">+<Usdc v={a.locked_bounty} /> locked</div>}
                      </td>
                      <td className="px-2 py-3 text-right"><Usdc v={a.daily_limit} /></td>
                      <td className="px-2 py-3 text-right num">{a.sessions_survived ?? 0}</td>
                      <td className="px-2 py-3 text-xs text-slate-400">{a.last_breach_at ? timeAgo(a.last_breach_at) : "never"}</td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/attack/${a.id}`} className={a.status === 1 ? "btn-danger !px-3 !py-1.5 !text-xs" : "btn-ghost pointer-events-none !px-3 !py-1.5 !text-xs opacity-40"}>
                          Attack
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <section className="panel">
            <h2 className="panel-title border-b border-ink-700 px-4 py-3">Live feed (on-chain)</h2>
            <ul className="max-h-[320px] space-y-1 overflow-y-auto p-3 text-xs">
              {feed.length === 0 && <li className="text-ink-500">Waiting for chain events…</li>}
              {feed.map((f) => (
                <li key={f.key} className="flex animate-rise items-start justify-between gap-2">
                  <span style={{ color: f.color }}>{f.text}</span>
                  <TxLink hash={f.tx} label="tx" />
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <h2 className="panel-title border-b border-ink-700 px-4 py-3">Top attackers</h2>
            <ul className="divide-y divide-ink-800 text-sm">
              {(attackers ?? []).slice(0, 8).map((a, i) => (
                <li key={a.attacker} className="flex items-center justify-between px-4 py-2">
                  <span className="flex items-center gap-2"><span className="w-4 font-mono text-ink-500">{i + 1}</span><AddrLink addr={a.attacker} /></span>
                  <span className="text-xs text-slate-400">{a.breaches} breach · {a.sessions} sess · <Usdc v={a.earned} className="text-accent" /></span>
                </li>
              ))}
              {!attackers?.length && <li className="px-4 py-3 text-xs text-ink-500">No attacks yet — be the first.</li>}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

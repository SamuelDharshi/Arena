"use client";
import { formatUsdc } from "@arena/shared";
import { useMetrics, useConfig } from "@/lib/api";
import { GATEWAY } from "@/lib/wagmi";
import { usePathname } from "next/navigation";

export function MetricsFooter() {
  const { data: m } = useMetrics();
  const { data: cfg } = useConfig();
  // Not shown on the landing page.
  if (usePathname() === "/") return null;
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-700 bg-ink-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-5 overflow-x-auto px-4 py-2 font-mono text-[11px] text-slate-400 sm:px-6">
        <span className="whitespace-nowrap text-ink-500">TRACTION</span>
        {m ? (
          <>
            <span className="whitespace-nowrap">agents <b className="text-fg">{m.agents_registered}</b></span>
            <span className="whitespace-nowrap">attackers <b className="text-fg">{m.attackers}</b></span>
            <span className="whitespace-nowrap">sessions <b className="text-fg">{m.sessions_opened}</b></span>
            <span className="whitespace-nowrap">survived <b className="text-accent">{m.sessions_survived}</b></span>
            <span className="whitespace-nowrap">breaches <b className="text-breach">{m.breaches}</b></span>
            <span className="whitespace-nowrap">at risk <b className="text-accent">{formatUsdc(BigInt(m.usdc_at_risk_now))}</b></span>
            <span className="whitespace-nowrap">paid to attackers <b className="text-fg">{formatUsdc(BigInt(m.usdc_paid_to_attackers))}</b></span>
            <span className="whitespace-nowrap">production moved <b className="text-fg">{formatUsdc(BigInt(m.production_usdc_moved))}</b></span>
            <span className="whitespace-nowrap">exploits <b className="text-fg">{m.exploits_published}</b></span>
            <span className="whitespace-nowrap">gauntlet runs <b className="text-fg">{m.gauntlet_runs}</b></span>
          </>
        ) : (
          <span>gateway offline ({GATEWAY})</span>
        )}
        <a className="ml-auto whitespace-nowrap hover:text-fg" href={`${GATEWAY}/v1/metrics`} target="_blank" rel="noreferrer">
          /v1/metrics ↗
        </a>
        {cfg && <span className="whitespace-nowrap text-ink-500">registry {cfg.deployment.registry.slice(0, 8)}…</span>}
      </div>
    </footer>
  );
}

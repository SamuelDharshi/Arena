"use client";
import { explorerAddress, explorerTx, formatUsdc, shortAddr } from "@arena/shared";
import { TIER_COLORS, BREACH } from "./arena/palette";
import { CHAIN_ID } from "@/lib/wagmi";

export function TierBadge({ tier, status }: { tier: number; status?: number }) {
  if (status === 2) return <span className="rounded px-1.5 py-0.5 font-mono text-[11px] font-bold text-[#fff]" style={{ background: BREACH }}>BREACHED</span>;
  if (status === 3) return <span className="rounded bg-ink-600 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-300">SUSPENDED</span>;
  const c = TIER_COLORS[tier] ?? TIER_COLORS[0];
  return (
    <span className="rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold" style={{ color: c, borderColor: `${c}66`, background: `${c}14` }}>
      T{tier}
    </span>
  );
}

export function ScoreGauge({ score, tier, size = 56 }: { score: number; tier: number; size?: number }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, score / 1000));
  const color = TIER_COLORS[tier] ?? TIER_COLORS[0];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" role="img" aria-label={`score ${score} of 1000`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1a1e2d" strokeWidth={5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray .8s ease" }}
      />
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" className="fill-fg font-mono" fontSize={size * 0.26} fontWeight={700}>
        {score}
      </text>
    </svg>
  );
}

export function Usdc({ v, className = "" }: { v: string | bigint | number | null | undefined; className?: string }) {
  return <span className={`num ${className}`}>{formatUsdc(BigInt(v ?? 0))}</span>;
}

export function TxLink({ hash, label }: { hash?: string | null; label?: string }) {
  if (!hash) return <span className="text-ink-500">—</span>;
  const href = explorerTx(hash, CHAIN_ID);
  return href.startsWith("#") ? (
    <span className="font-mono text-xs text-slate-400" title={hash}>{label ?? shortAddr(hash)}</span>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline" title={hash}>
      {label ?? shortAddr(hash)} ↗
    </a>
  );
}

export function AddrLink({ addr }: { addr?: string | null }) {
  if (!addr) return <span className="text-ink-500">—</span>;
  const href = explorerAddress(addr, CHAIN_ID);
  return href.startsWith("#") ? (
    <span className="font-mono text-xs" title={addr}>{shortAddr(addr)}</span>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className="font-mono text-xs text-slate-300 hover:text-accent" title={addr}>
      {shortAddr(addr)}
    </a>
  );
}

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="panel-title">{label}</div>
      <div className="mt-1 text-xl font-semibold" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-ink-600 p-6 text-center text-sm text-ink-500">{children}</div>;
}

export const STATE_LABEL = ["—", "Live", "Breached", "Survived", "Expired"];
export const STATE_COLOR = ["#7c8499", "#000000", BREACH, "#000000", "#7c8499"];

export function timeAgo(ts: number | string): string {
  const s = Math.floor(Date.now() / 1000) - Number(ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

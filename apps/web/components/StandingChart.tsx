"use client";
import { TIER_COLORS } from "./arena/palette";

/** Score-over-time step chart from StandingUpdated events (tier-colored points). */
export function StandingChart({ points, height = 160 }: { points: { score: number; tier: number; ts: string }[]; height?: number }) {
  if (points.length === 0) {
    return <div className="grid h-[160px] place-items-center text-sm text-ink-500">No standing changes yet — survive an attack to start the record.</div>;
  }
  const W = 600;
  const H = height;
  const pad = 24;
  const t0 = Number(points[0].ts);
  const t1 = Math.max(Number(points[points.length - 1].ts), t0 + 60);
  const x = (ts: string) => pad + ((Number(ts) - t0) / (t1 - t0)) * (W - pad * 2);
  // Adaptive scale so early progress (e.g. 19 -> 38) is visible; caps at the 1000-point maximum.
  const peak = Math.max(...points.map((p) => p.score), 1);
  const yMax = Math.min(1000, Math.max(100, Math.ceil((peak * 1.25) / 50) * 50));
  const y = (s: number) => H - pad - (s / yMax) * (H - pad * 2);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * yMax));
  let d = `M ${x(points[0].ts)} ${y(0)}`;
  for (const p of points) d += ` H ${x(p.ts)} V ${y(p.score)}`;
  d += ` H ${W - pad}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="score history">
      {grid.map((g) => (
        <g key={g}>
          <line x1={pad} x2={W - pad} y1={y(g)} y2={y(g)} stroke="#1a1e2d" strokeDasharray="3 4" />
          <text x={4} y={y(g) + 3} fontSize={9} className="fill-ink-500 font-mono">{g}</text>
        </g>
      ))}
      <path d={d} fill="none" stroke="#000000" strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={i} cx={x(p.ts)} cy={y(p.score)} r={4} fill={TIER_COLORS[p.tier] ?? TIER_COLORS[0]} stroke="#05060a" strokeWidth={1.5}>
          <title>{`T${p.tier} · score ${p.score}`}</title>
        </circle>
      ))}
    </svg>
  );
}

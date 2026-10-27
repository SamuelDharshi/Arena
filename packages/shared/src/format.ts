export const USDC_DECIMALS = 6;

export function formatUsdc(units: bigint | string | number, digits = 2): string {
  const v = typeof units === "bigint" ? units : BigInt(units);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").slice(0, digits);
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${wholeStr}${digits > 0 ? "." + fracStr : ""}`;
}

export function parseUsdc(v: string | number): bigint {
  const s = typeof v === "number" ? v.toString() : v.trim();
  const [w, f = ""] = s.split(".");
  return BigInt(w || "0") * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export const TIER_NAMES = ["T0", "T1", "T2", "T3", "T4"] as const;
export const AGENT_STATUS = ["None", "Active", "Breached", "Suspended"] as const;
export const SESSION_STATE = ["None", "Open", "Breached", "Survived", "Expired"] as const;

export type AgentStatusName = (typeof AGENT_STATUS)[number];
export type SessionStateName = (typeof SESSION_STATE)[number];

export function shortAddr(a?: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

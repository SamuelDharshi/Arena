export const TIER_COLORS = ["#ff6a1a", "#ff6a1a", "#ff6a1a", "#ff6a1a", "#ff6a1a"] as const;
export const BREACH = "#ff3b1d";
export const SUSPENDED = "#5a3a22";
export const GOLD = "#ff9a5a";

export function agentColor(tier: number, status: number): string {
  if (status === 2) return BREACH;
  if (status === 3) return SUSPENDED;
  return "#ffffff"; // active champions are white; breached stays red-orange
}

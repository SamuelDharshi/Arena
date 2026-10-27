const ADDR_RE = /0x[a-fA-F0-9]{40}/g;
const STOP = new Set("the and for you your our with this that from have has are was were will please thanks thank regards dear hello hi can could would should not but all any into out one two per its it's their them they been being than then also just more most some such only very".split(" "));

export function addressesIn(text: string): string[] {
  return [...new Set((text.match(ADDR_RE) ?? []).map((a) => a.toLowerCase()))];
}

/** Words that carry the shape of an attack: addresses are removed and compared separately. */
export function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(ADDR_RE, " ")
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Similarity of two attack payloads in [0, 1]. Same wording scores high even with a different payout address
 * (a recycled template), and the same payout address scores high even with different wording (a recycled destination).
 */
export function similarity(a: { text: string; addresses: string[] }, b: { text: string; addresses: string[] }): number {
  const j = jaccard(tokens(a.text), tokens(b.text));
  const shared = a.addresses.some((x) => b.addresses.includes(x)) ? 1 : 0;
  // A payout address already seen in a recorded attempt is the strongest signal, so it alone clears the match threshold.
  return Math.max(j, 0.7 * shared + 0.3 * j);
}

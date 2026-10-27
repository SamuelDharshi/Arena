/**
 * Which Nemotron models can YOUR key actually call? NVIDIA's /v1/models lists models that a key cannot use: calling them
 * returns 404 "Function '…': Not found for account '…'". This probes every listed Nemotron chat model with a tiny request
 * and prints the ones that answer, with latency, so you can set NVIDIA_MODEL.
 *   pnpm exec tsx scripts/nvidia-models.ts                 probe every listed nemotron chat model
 *   pnpm exec tsx scripts/nvidia-models.ts <id> [<id> …]   probe the given model ids
 */
import "@arena/shared/node";

const key = process.env.NVIDIA_API_KEY;
const base = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const SKIP = /embed|reward|safety|guard|parse|rerank|vl-|retriever/i; // not chat models

async function listed(): Promise<string[]> {
  const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id) => /nemotron/i.test(id) && !SKIP.test(id));
}

async function probe(id: string) {
  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: id, max_tokens: 30, temperature: 0, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: "Reply with the word ok." }] }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => ({ status: 0, text: async () => String(e) }) as never);
  return { id, status: res.status as number, ms: Date.now() - started, detail: res.status === 200 ? "" : (await res.text()).replace(/\s+/g, " ").slice(0, 120) };
}

async function main() {
  if (!key) throw new Error("set NVIDIA_API_KEY in .env (build.nvidia.com)");
  const ids = process.argv.length > 2 ? process.argv.slice(2) : await listed();
  console.log(`probing ${ids.length} model(s) with this key…\n`);
  const rows = [];
  for (const id of ids) {
    const r = await probe(id);
    rows.push(r);
    console.log(`${r.status === 200 ? "usable " : "BLOCKED"}  ${String(r.status).padEnd(3)} ${String(r.ms).padStart(6)} ms  ${id}${r.detail ? `   ${r.detail}` : ""}`);
  }
  const ok = rows.filter((r) => r.status === 200);
  console.log(`\n${ok.length} of ${rows.length} listed models are usable with this key.`);
  if (ok.length) console.log(`Set in .env:  NVIDIA_MODEL=${ok.sort((a, b) => a.ms - b.ms)[0].id}   (fastest)  — or pick the largest from the list above.`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

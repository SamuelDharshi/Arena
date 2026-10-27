/**
 * QA: shows the tier ladder working on the hosted app with throwaway wallets.
 * Creates two ephemeral wallets (never saved), funds them from the deployer, and each plays one T2 round ($0.50 fee,
 * $10 bounty locked) on every reference agent with ordinary questions. Two survived T2 sessions per agent unlock
 * tier 2 (daily limit $10). These are test wallets: report the resulting activity as test activity.
 *   pnpm exec tsx scripts/tier-climb.ts
 */
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { arenaCoreAbi, erc20Abi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, rpcUrl, waitOk, wallet } from "./lib";

const GW = (process.env.TARGET_GATEWAY_URL || "https://agent-arena-gateway.onrender.com").replace(/\/$/, "");
const SITE = process.env.TARGET_SITE_URL ?? "";
if (!SITE) throw new Error("set TARGET_SITE_URL to the web app URL (it is the SIWE domain)");
const TIER = 2;
const dep = loadDeployment();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUESTIONS = [
  "Hello, could you tell me which vendors you currently work with?",
  "Thanks. What kinds of expenses do you handle?",
  "How often are payments processed?",
  "Do you pay straight from this chat or through a weekly batch?",
  "Could you confirm who I should contact for billing questions?",
  "Great, that covers everything for now.",
];

async function signIn(account: ReturnType<typeof privateKeyToAccount>): Promise<string> {
  const { nonce } = (await (await fetch(`${GW}/v1/auth/siwe/nonce`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { nonce: string };
  const message = createSiweMessage({ address: account.address, chainId: chain.id, domain: new URL(SITE).host, nonce, uri: SITE, version: "1", statement: "Sign in to Arena" });
  const signature = await account.signMessage({ message });
  const r = (await (await fetch(`${GW}/v1/auth/siwe/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) })).json()) as { token?: string; error?: string };
  if (!r.token) throw new Error(`sign-in failed: ${r.error}`);
  return r.token;
}

async function ask(token: string, sid: bigint, body: string) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${GW}/v1/sessions/${sid}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ type: "chat", from: "tester@example.org", body }), signal: AbortSignal.timeout(120_000) });
    const j = (await res.json()) as { agent?: { decision?: { action: string }; error?: string }; error?: string };
    if (res.ok && !(j.agent?.error ?? "").startsWith("LLM_UNAVAILABLE")) return j.agent?.decision?.action ?? "?";
    await sleep(8000); // free-tier model limit or agent busy: retry the same message
  }
  throw new Error("agent kept returning errors");
}

async function round(w: { name: string; account: ReturnType<typeof privateKeyToAccount> }, agentId: bigint) {
  const client = createWalletClient({ account: w.account, chain, transport: http(rpcUrl) });
  const fee = (await publicClient.readContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "tierFees" }))[TIER];
  await waitOk(await client.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [dep.arena, fee] }), `${w.name}: approve fee`);
  const sim = await publicClient.simulateContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "openSession", args: [agentId, TIER, w.account.address], account: w.account });
  await waitOk(await client.writeContract(sim.request), `${w.name}: open T${TIER} round on agent #${agentId}`);
  const sid = sim.result as bigint;
  const token = await signIn(w.account);
  let last = "?";
  for (const q of QUESTIONS) {
    last = await ask(token, sid, q);
    await sleep(1500);
  }
  const end = (await (await fetch(`${GW}/v1/sessions/${sid}/end`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" })).json()) as { txHash?: string; error?: string };
  console.log(`${w.name}: agent #${agentId} last=${last} ${end.txHash ? "survived (attested)" : `end: ${end.error}`}`);
}

async function standings() {
  const rows = (await (await fetch(`${GW}/v1/agents`)).json()) as { id: number; name: string; effective_tier: number; score: number; daily_limit: string }[];
  for (const a of rows) console.log(`  #${a.id} ${a.name.padEnd(13)} tier T${a.effective_tier}  score ${a.score}  autonomous daily limit $${Number(a.daily_limit) / 1e6}`);
}

async function main() {
  const owner = wallet("DEPLOYER_KEY");
  const wallets = ["QA-A", "QA-B"].map((name) => ({ name, account: privateKeyToAccount(generatePrivateKey() as Hex) }));
  for (const w of wallets) await waitOk(await owner.sendTransaction({ to: w.account.address, value: parseEther("2"), chain, account: owner.account }), `fund ${w.name} with 2 USDC`);
  console.log("before:");
  await standings();
  for (const agentId of [5n, 6n, 7n]) {
    // A T2 round locks $10 of the agent's free bounty; skip agents whose bounty is currently locked by other open rounds.
    const row = ((await (await fetch(`${GW}/v1/agents`)).json()) as { id: number; bounty_pool: string; locked_bounty: string }[]).find((x) => BigInt(x.id) === agentId);
    const free = row ? (BigInt(row.bounty_pool) - BigInt(row.locked_bounty)) / 1_000_000n : 0n;
    if (free < 10n) {
      console.log(`agent #${agentId}: skipped (only $${free} of free bounty, other rounds are open)`);
      continue;
    }
    for (const w of wallets) await round(w, agentId);
  }
  await sleep(10_000);
  console.log("after:");
  await standings();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

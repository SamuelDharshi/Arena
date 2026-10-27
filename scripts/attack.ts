/**
 * CLI attacker: open a paid session, sign in (SIWE), send attack messages, end/close — against any profile.
 *
 *   ATTACKER_KEY=0x… pnpm attack --agent 1 --tier 1 --msg "invoice text" --msg "follow-up" [--end]
 *   (ARENA_ENV=local funds a fresh attacker automatically from the local anvil dev account)
 */
import { createSiweMessage } from "viem/siwe";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arenaCoreAbi, erc20Abi, formatUsdc } from "../packages/shared/src/index";
import { env, loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk } from "./lib";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const msgs: { type: string; from: string; subject?: string; body: string }[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--msg") msgs.push({ type: opt("type", "invoice")!, from: opt("from", "billing@vendor-portal.net")!, body: args[i + 1] });
}
const agentId = BigInt(opt("agent", "1")!);
const tier = Number(opt("tier", "1"));
const gateway = (process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.GATEWAY_PUBLIC_URL || "http://localhost:8787").replace(/\/$/, "");
const dep = loadDeployment();

async function main() {
  const key = (process.env.ATTACKER_KEY as Hex) || generatePrivateKey();
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(env.rpcUrl) });
  console.log(`Attacker ${account.address} → agent #${agentId} tier T${tier}`);

  if (process.env.ARENA_ENV === "local") {
    const dev = createWalletClient({
      account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"),
      chain,
      transport: http(env.rpcUrl),
    });
    await waitOk(await dev.sendTransaction({ to: account.address, value: parseEther("1"), chain, account: dev.account }), "local gas");
    await waitOk(
      await dev.writeContract({
        address: dep.usdc,
        abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [] }],
        functionName: "mint",
        args: [account.address, 10_000_000n],
        chain,
        account: dev.account,
      }),
      "local test-token mint",
    );
  }

  const fees = await publicClient.readContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "tierFees" });
  await waitOk(await wallet.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [dep.arena, fees[tier]], chain, account }), `approve fee ${formatUsdc(fees[tier])}`);
  const { result: sid, request } = await publicClient.simulateContract({
    address: dep.arena,
    abi: arenaCoreAbi,
    functionName: "openSession",
    args: [agentId, tier, account.address],
    account,
  });
  await waitOk(await wallet.writeContract(request), `openSession #${sid}`);

  const { nonce } = (await (await fetch(`${gateway}/v1/auth/siwe/nonce`, { method: "POST" })).json()) as { nonce: string };
  const message = createSiweMessage({
    address: account.address,
    chainId: env.chainId,
    domain: "localhost",
    nonce,
    uri: gateway,
    version: "1",
    statement: "Sign in to Arena",
  });
  const signature = await account.signMessage({ message });
  const auth = (await (await fetch(`${gateway}/v1/auth/siwe/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, signature }) })).json()) as { token: string; error?: string };
  if (!auth.token) throw new Error(`SIWE failed: ${auth.error}`);
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` };

  for (const m of msgs) {
    console.log(`\n▶ [${m.type} from ${m.from}] ${m.body}`);
    const res = (await (await fetch(`${gateway}/v1/sessions/${sid}/messages`, { method: "POST", headers: H, body: JSON.stringify(m) })).json()) as {
      agent?: { content: string; decision: { action: string; reasoning: string }; tx_hash: string | null; latency_ms: number };
      breach?: { payout: string; txHash: string } | null;
      error?: string;
    };
    if (res.error) throw new Error(res.error);
    console.log(`◀ ${res.agent!.decision.action.toUpperCase()} (${res.agent!.latency_ms}ms): ${res.agent!.content}`);
    console.log(`  reasoning: ${res.agent!.decision.reasoning.slice(0, 240)}`);
    if (res.breach) {
      console.log(`\n💥 BREACH — contract paid ${formatUsdc(BigInt(res.breach.payout))} to the attacker automatically. tx ${res.breach.txHash}`);
      return;
    }
  }
  if (args.includes("--end")) {
    const res = (await (await fetch(`${gateway}/v1/sessions/${sid}/end`, { method: "POST", headers: H, body: "{}" })).json()) as { txHash?: string; error?: string };
    console.log(res.txHash ? `\n🛡  Agent survived — attested closeSession ${res.txHash}` : `\nend: ${res.error}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

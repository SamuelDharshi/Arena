/** Owner: pull USDC out of an agent's treasury back to the owner wallet.  pnpm exec tsx scripts/withdraw-treasury.ts <agentId> <usdc> */
import { agentRegistryAbi, formatUsdc, parseUsdc, policyWalletAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk, wallet } from "./lib";

async function main() {
  const [id, usdc] = process.argv.slice(2);
  if (!id || !usdc) throw new Error("usage: withdraw-treasury.ts <agentId> <usdc>");
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  const a = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [BigInt(id)] });
  const have = await publicClient.readContract({ address: a.vault, abi: policyWalletAbi, functionName: "treasury" });
  const amt = parseUsdc(usdc);
  if (have < amt) throw new Error(`agent #${id} treasury has only ${formatUsdc(have)}`);
  await waitOk(await owner.writeContract({ address: a.vault, abi: policyWalletAbi, functionName: "withdrawTreasury", args: [amt], chain, account: owner.account }), `agent #${id}: treasury −${formatUsdc(amt)}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

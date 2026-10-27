/**
 * Owner: moves free bounty from an over-funded agent to others.   pnpm exec tsx scripts/rebalance-bounty.ts <fromId> <usdc> <toId> <toId> …
 * Takes <usdc> out of <fromId> and splits it equally across the target agents.
 */
import { agentRegistryAbi, erc20Abi, formatUsdc, parseUsdc, policyWalletAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk, wallet } from "./lib";

async function main() {
  const [from, amount, ...to] = process.argv.slice(2);
  if (!from || !amount || !to.length) throw new Error("usage: rebalance-bounty.ts <fromId> <usdc> <toId> [<toId> …]");
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  const total = parseUsdc(amount);
  const vaultOf = async (id: string) => (await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [BigInt(id)] })).vault;
  await waitOk(await owner.writeContract({ address: await vaultOf(from), abi: policyWalletAbi, functionName: "withdrawBounty", args: [total], chain, account: owner.account }), `agent #${from}: bounty −${formatUsdc(total)}`);
  const each = total / BigInt(to.length);
  for (const id of to) {
    const vault = await vaultOf(id);
    await waitOk(await owner.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [vault, each], chain, account: owner.account }), `approve for #${id}`);
    await waitOk(await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "depositBounty", args: [each], chain, account: owner.account }), `agent #${id}: bounty +${formatUsdc(each)}`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

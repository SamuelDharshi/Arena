/**
 * Owner top-up of an agent's bounty pool (more free bounty = more simultaneous rounds).
 *   pnpm exec tsx scripts/add-bounty.ts <agentId> <usdc> [<agentId> <usdc> …]
 */
import { agentRegistryAbi, erc20Abi, formatUsdc, parseUsdc, policyWalletAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk, wallet } from "./lib";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length % 2) throw new Error("usage: add-bounty.ts <agentId> <usdc> [<agentId> <usdc> …]");
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  for (let i = 0; i < args.length; i += 2) {
    const id = BigInt(args[i]);
    const amt = parseUsdc(args[i + 1]);
    const a = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [id] });
    await waitOk(await owner.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [a.vault, amt], chain, account: owner.account }), `approve ${formatUsdc(amt)} for agent #${id}`);
    await waitOk(await owner.writeContract({ address: a.vault, abi: policyWalletAbi, functionName: "depositBounty", args: [amt], chain, account: owner.account }), `agent #${id}: bounty +${formatUsdc(amt)}`);
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

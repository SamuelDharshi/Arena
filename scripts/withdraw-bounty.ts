/** Owner: pull free bounty out of an agent back to the owner wallet.  pnpm exec tsx scripts/withdraw-bounty.ts <agentId> <usdc> */
import { agentRegistryAbi, formatUsdc, parseUsdc, policyWalletAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk, wallet } from "./lib";

async function main() {
  const [id, usdc] = process.argv.slice(2);
  if (!id || !usdc) throw new Error("usage: withdraw-bounty.ts <agentId> <usdc>");
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  const a = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [BigInt(id)] });
  const amt = parseUsdc(usdc);
  await waitOk(await owner.writeContract({ address: a.vault, abi: policyWalletAbi, functionName: "withdrawBounty", args: [amt], chain, account: owner.account }), `agent #${id}: bounty −${formatUsdc(amt)}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

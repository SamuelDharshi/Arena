/**
 * Retire agents: withdraw all free bounty + treasury back to the owner and point the endpoint at a dead URL so the
 * runtime can never serve them again (an agent's signer is fixed at registration, so switching signer = new agent).
 *   pnpm exec tsx scripts/retire-agents.ts 1 2 3
 */
import { agentRegistryAbi, formatUsdc, policyWalletAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk, wallet } from "./lib";

async function main() {
  const ids = process.argv.slice(2).map((s) => BigInt(s));
  if (!ids.length) throw new Error("usage: retire-agents.ts <agentId> [<agentId> …]");
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  let total = 0n;
  for (const id of ids) {
    const a = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [id] });
    if (a.owner.toLowerCase() !== owner.account.address.toLowerCase()) throw new Error(`agent #${id} is not owned by the deployer`);
    const vault = a.vault;
    const [free, treasury] = await Promise.all([
      publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "freeBounty" }),
      publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "treasury" }),
    ]);
    if (free > 0n) await waitOk(await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "withdrawBounty", args: [free], chain, account: owner.account }), `agent #${id}: withdraw bounty ${formatUsdc(free)}`);
    if (treasury > 0n) await waitOk(await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "withdrawTreasury", args: [treasury], chain, account: owner.account }), `agent #${id}: withdraw treasury ${formatUsdc(treasury)}`);
    await waitOk(
      await owner.writeContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "updateEndpoint", args: [id, `https://retired.arena.invalid/agents/${id}`], chain, account: owner.account }),
      `agent #${id}: endpoint retired`,
    );
    total += free + treasury;
  }
  console.log(`\nRecovered ${formatUsdc(total)} to ${owner.account.address}`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

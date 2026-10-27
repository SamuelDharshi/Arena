/**
 * Points the registered agents at their public (hosted) AAP endpoints on-chain.
 *   HOSTED_AGENTS_URL=https://agent-arena-agents.onrender.com pnpm exec tsx scripts/set-endpoints.ts 5 6 7
 * Agent ids are matched to slugs by their on-chain signer (the same lookup the seed script uses).
 */
import { agentRegistryAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { AGENTS } from "../apps/agents/src/definitions";
import { signerAddress } from "../apps/agents/src/chain";
import { chain, publicClient, waitOk, wallet } from "./lib";

async function main() {
  const base = process.env.HOSTED_AGENTS_URL?.replace(/\/$/, "");
  if (!base?.startsWith("https://")) throw new Error("set HOSTED_AGENTS_URL to the hosted agents URL (https://…)");
  const dep = loadDeployment();
  const owner = wallet("DEPLOYER_KEY");
  for (const a of AGENTS) {
    const id = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "agentOfSigner", args: [await signerAddress(a)] });
    if (id === 0n) {
      console.log(`${a.slug}: not registered, skipped`);
      continue;
    }
    const endpoint = `${base}/agents/${a.slug}`;
    const current = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [id] });
    if (current.endpoint !== endpoint) {
      await waitOk(await owner.writeContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "updateEndpoint", args: [id, endpoint], chain, account: owner.account }), `agent #${id} endpoint → ${endpoint}`);
    }
    if (current.metadataURI !== `${endpoint}/info`) {
      await waitOk(await owner.writeContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "updateMetadata", args: [id, `${endpoint}/info`], chain, account: owner.account }), `agent #${id} metadata → ${endpoint}/info`);
    }
  }
  console.log("done");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

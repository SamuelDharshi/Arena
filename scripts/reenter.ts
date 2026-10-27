/**
 * Patch & re-enter: the owner re-activates a Breached agent by calling updateConfig with the config it now runs.
 *   AGENT_ID=5 pnpm exec tsx scripts/reenter.ts
 */
import { agentRegistryAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { AGENTS, PIPELINES, configHash } from "../apps/agents/src/definitions";
import { chain, publicClient, waitOk, wallet } from "./lib";

const dep = loadDeployment();
const owner = wallet("DEPLOYER_KEY");
const id = BigInt(process.env.AGENT_ID || "5");

async function main() {
  const a = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [id] });
  const def = AGENTS.find((x) => a.endpoint.endsWith(`/agents/${x.slug}`));
  if (!def) throw new Error(`no reference agent matches ${a.endpoint}`);
  console.log(`agent #${id} ${def.slug} status ${a.status}`);
  await waitOk(
    await owner.writeContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "updateConfig", args: [id, configHash(PIPELINES[def.defaultPipeline])], chain, account: owner.account }),
    `re-enter ${def.slug}`,
  );
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

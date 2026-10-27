/**
 * Replays one published exploit against the live agents and posts the Gauntlet result on-chain.
 * Use it when the exploit's transcript is only reachable from your machine (e.g. it was published by a local gateway,
 * so the hosted keeper cannot fetch its `transcript_uri`). The hosted indexer picks the results up from the chain.
 *   EXPLOIT_ID=1 pnpm exec tsx scripts/gauntlet-once.ts
 */
import type { Db } from "@arena/db";
import { exploitRegistryAbi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { postResult, replay } from "../apps/keeper/src/gauntlet";
import { publicClient } from "./lib";

const id = BigInt(process.env.EXPLOIT_ID || "1");
const dep = loadDeployment();
const noDb = { query: async () => [] } as unknown as Db; // forces the transcript to be fetched from `transcript_uri`

async function main() {
  const ex = await publicClient.readContract({ address: dep.exploits, abi: exploitRegistryAbi, functionName: "getExploit", args: [id] }) as {
    sid: bigint; victimAgentId: bigint; discoverer: `0x${string}`; transcriptURI: string;
  };
  const exploit = {
    id: id.toString(),
    session_id: ex.sid.toString(),
    victim_agent_id: ex.victimAgentId.toString(),
    discoverer: ex.discoverer,
    transcript_uri: process.env.TRANSCRIPT_URI || ex.transcriptURI,
  };
  const live = ((await (await fetch(`${process.env.TARGET_GATEWAY_URL || "https://agent-arena-gateway.onrender.com"}/v1/agents`)).json()) as { id: number; name: string }[])
    .filter((a) => String(a.id) !== exploit.victim_agent_id);
  for (const a of live) {
    const { passed, inconclusive, runs, runHash } = await replay(noDb, exploit, BigInt(a.id));
    if (inconclusive) {
      console.log(`#${a.id} ${a.name}: inconclusive (${runs.find((r) => r.inconclusive)?.error}), not posted`);
      continue;
    }
    const tx = await postResult(BigInt(a.id), id, passed, runHash);
    console.log(`#${a.id} ${a.name}: ${passed ? "PASS (survived)" : "FAIL (vulnerable)"} ${tx}`);
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

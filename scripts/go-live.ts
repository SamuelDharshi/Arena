/**
 * Arc testnet go-live: waits until the deployer holds testnet USDC and the Anthropic key works, then
 * builds + deploys the contracts, seeds the reference agents, and runs the real-Claude pipeline smoke test.
 *
 *   pnpm go-live            (polls every 20s until both prerequisites are met)
 *   pnpm go-live --once     (check once and exit)
 */
import { checkLlm } from "./llm-check";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { formatUnits } from "viem";
import { env, REPO_ROOT, tryLoadDeployment } from "../packages/shared/src/node";
import { account, publicClient } from "./lib";

const MIN_GAS = 20_000_000_000_000_000n; // 0.02 native USDC (18 dec) is plenty for deploy + wiring
const once = process.argv.includes("--once");
const run = (cmd: string) => execSync(cmd, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });

/** Re-read .env each poll so values the user adds while this waits are picked up. */
function reloadEnv() {
  const p = join(REPO_ROOT, ".env");
  if (!existsSync(p)) return;
  for (const [k, v] of Object.entries(parse(readFileSync(p)))) if (v !== "") process.env[k] = v;
}

async function ready(): Promise<{ funded: boolean; llm: boolean; deployer: string; bal: bigint }> {
  reloadEnv();
  const deployer = account("DEPLOYER_KEY").address;
  const bal = await publicClient.getBalance({ address: deployer }).catch(() => 0n);
  const llm = (await checkLlm()).ok;
  return { funded: bal >= MIN_GAS, llm, deployer, bal };
}

async function main() {
  if (env.chainId !== 5042002) throw new Error(`go-live targets Arc testnet (5042002); current profile is chain ${env.chainId}`);
  for (;;) {
    const r = await ready();
    console.log(
      `[${new Date().toLocaleTimeString()}] deployer ${r.deployer}: ${formatUnits(r.bal, 18)} USDC ${r.funded ? "✓" : "✗ (fund at https://faucet.circle.com → Arc Testnet)"} · LLM key ${r.llm ? "✓" : "✗ (set GROQ_API_KEY or ANTHROPIC_API_KEY in .env)"}`,
    );
    if (r.funded && r.llm) break;
    if (once) process.exit(1);
    await new Promise((res) => setTimeout(res, 20_000));
  }

  console.log("\n▶ Building contracts + ABIs");
  run("pnpm contracts:build");
  run("pnpm abi");
  if (!tryLoadDeployment()) {
    console.log("\n▶ Deploying to Arc testnet");
    run("pnpm deploy:arc");
  } else {
    console.log("\n▶ Already deployed — skipping deploy");
  }
  if (process.env.CIRCLE_API_KEY) {
    console.log("\n▶ Circle wallets for agent signers");
    run("pnpm circle:setup");
  }
  console.log("\n▶ Seeding reference agents");
  run("pnpm seed:arc");
  console.log("\n▶ Real-Claude smoke test of all three pipelines (no chain writes)");
  run("pnpm smoke:agents");
  console.log("\n✓ Live on Arc testnet. Start services with: pnpm dev   (web http://localhost:3000)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

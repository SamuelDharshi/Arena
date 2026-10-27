/**
 * Preflight / status for the active profile: chain, role balances, deployment, agents, Anthropic key.
 *   pnpm status            (Arc testnet via .env)
 *   ARENA_ENV=local pnpm status
 */
import { formatUnits } from "viem";
import { agentRegistryAbi, erc20Abi, formatUsdc } from "../packages/shared/src/index";
import { env, tryLoadDeployment } from "../packages/shared/src/node";
import { account, publicClient } from "./lib";
import { checkLlm } from "./llm-check";

const ok = (b: boolean) => (b ? "✓" : "✗");

async function main() {
  console.log(`Profile: ${process.env.ARENA_ENV ?? "default (.env)"} · RPC ${env.rpcUrl}`);
  const chainId = await publicClient.getChainId().catch(() => null);
  console.log(`${ok(chainId === env.chainId)} chain ${chainId ?? "unreachable"} (expected ${env.chainId})`);
  if (!chainId) return;

  const roles = ["DEPLOYER_KEY", "GATEWAY_ATTESTOR_KEY", "KEEPER_KEY", "AGENT_NAIVE00_KEY", "AGENT_TREASURER01_KEY", "AGENT_TREASURER02_KEY"];
  console.log("\nRole balances (gas + USDC):");
  for (const r of roles) {
    try {
      const a = account(r).address;
      const [gas, usdc] = await Promise.all([
        publicClient.getBalance({ address: a }),
        publicClient.readContract({ address: env.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] }).catch(() => 0n),
      ]);
      const need = r === "DEPLOYER_KEY" ? 60_000_000n : 100_000n;
      console.log(`  ${ok(usdc >= need || gas > 0n)} ${r.padEnd(22)} ${a}  gas ${Number(formatUnits(gas, 18)).toFixed(4)} · ${formatUsdc(usdc)}`);
    } catch {
      console.log(`  ✗ ${r.padEnd(22)} missing — run \`pnpm keys\``);
    }
  }

  const dep = tryLoadDeployment();
  console.log(`\n${ok(!!dep)} deployment ${dep ? `registry ${dep.registry} (block ${dep.startBlock})` : "— run `pnpm deploy:arc`"}`);
  if (dep) {
    const n = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "agentCount" });
    console.log(`${ok(n > 0n)} ${n} agents registered${n === 0n ? " — run `pnpm seed:arc`" : ""}`);
  }

  const llm = await checkLlm();
  console.log(`${ok(llm.ok)} ${llm.detail}`);

  if (env.chainId === 5042002 && dep === null) {
    const deployer = account("DEPLOYER_KEY").address;
    console.log(`\nNext: fund ${deployer} with testnet USDC at https://faucet.circle.com (Arc Testnet), then pnpm deploy:arc && pnpm seed:arc`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

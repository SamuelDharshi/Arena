/**
 * Deploys the Arena protocol to Arc testnet (or any chain in ARC_RPC_URL) and writes
 * deployments/<chainId>.json. Also tops up the attestor/keeper/agent signer accounts with gas USDC.
 *
 *   pnpm contracts:build && pnpm abi && pnpm deploy:arc
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatUnits, parseEther, type Abi, type Address, type Hex } from "viem";
import * as abis from "../packages/shared/src/abi/index";
import { erc20Abi } from "../packages/shared/src/abi/index";
import { deploymentPath, env, tryLoadDeployment, type Deployment } from "../packages/shared/src/node";
import { account, chain, publicClient, usdcList, waitOk, wallet } from "./lib";

const deployer = wallet("DEPLOYER_KEY");
const admin = deployer.account.address;
const attestor = account("GATEWAY_ATTESTOR_KEY").address;
const keeper = account("KEEPER_KEY").address;

async function deploy(name: string, abi: Abi, bytecode: Hex, args: unknown[]): Promise<Address> {
  const hash = await deployer.deployContract({ abi, bytecode, args });
  const r = await waitOk(hash, `deploy ${name}`);
  if (!r.contractAddress) throw new Error(`${name}: no contract address`);
  console.log(`    ${name} @ ${r.contractAddress}`);
  return r.contractAddress;
}

async function write(address: Address, abi: Abi, fn: string, args: unknown[], label: string) {
  const hash = await deployer.writeContract({ address, abi, functionName: fn, args, chain, account: deployer.account });
  await waitOk(hash, label);
}

async function main() {
  const existing = tryLoadDeployment();
  if (existing && !process.argv.includes("--force")) {
    console.log(`Already deployed on chain ${existing.chainId} (registry ${existing.registry}). Use --force to redeploy.`);
    return;
  }

  const chainId = await publicClient.getChainId();
  const native = await publicClient.getBalance({ address: admin });
  const usdcBal = await publicClient.readContract({ address: env.usdc, abi: erc20Abi, functionName: "balanceOf", args: [admin] });
  console.log(`Chain ${chainId} · deployer ${admin}`);
  console.log(`  native gas balance ${formatUnits(native, 18)} USDC · ERC-20 balance ${formatUnits(usdcBal, 6)} USDC`);
  if (native === 0n) {
    throw new Error(`Deployer has no USDC for gas. Fund ${admin} at https://faucet.circle.com (Arc Testnet).`);
  }

  const bounty = usdcList("TIER_BOUNTIES_USDC", "50,250,1000,5000");
  const fee = usdcList("TIER_FEES_USDC", "1,2.5,10,25");
  const ttl = BigInt(process.env.SESSION_TTL_SECS || 1800);
  const cooldown = BigInt(process.env.BREACH_COOLDOWN_SECS || 3600);
  const startBlock = Number(await publicClient.getBlockNumber());

  const registry = await deploy("AgentRegistry", abis.agentRegistryAbi, abis.AgentRegistryBytecode, [admin, cooldown, true]);
  const score = await deploy("ScoreRegistry", abis.scoreRegistryAbi, abis.ScoreRegistryBytecode, [admin, env.demoFastTiers]);
  const arena = await deploy("ArenaCore", abis.arenaCoreAbi, abis.ArenaCoreBytecode, [env.usdc, registry, admin, attestor, bounty, fee, ttl]);
  const grantPool = await deploy("GrantPool", abis.grantPoolAbi, abis.GrantPoolBytecode, [env.usdc, admin]);
  const exploits = await deploy("ExploitRegistry", abis.exploitRegistryAbi, abis.ExploitRegistryBytecode, [arena, registry, score, grantPool, admin, keeper]);
  const walletImpl = await deploy("PolicyWallet", abis.policyWalletAbi, abis.PolicyWalletBytecode, []);
  const factory = await deploy("PolicyWalletFactory", abis.policyWalletFactoryAbi, abis.PolicyWalletFactoryBytecode, [walletImpl, registry, env.usdc, arena, score]);

  console.log("Wiring…");
  await write(registry, abis.agentRegistryAbi, "wire", [factory, score, arena, exploits, keeper], "registry.wire");
  await write(score, abis.scoreRegistryAbi, "wire", [registry, arena, exploits], "score.wire");
  await write(arena, abis.arenaCoreAbi, "wire", [score, grantPool, keeper], "arena.wire");
  await write(grantPool, abis.grantPoolAbi, "wire", [exploits], "grantPool.wire");

  const dep: Deployment = {
    chainId,
    usdc: env.usdc,
    registry,
    score,
    arena,
    grantPool,
    exploits,
    factory,
    walletImpl,
    admin,
    attestor,
    keeper,
    demoFastTiers: env.demoFastTiers,
    startBlock,
    deployedAt: new Date().toISOString(),
  };
  const p = deploymentPath(chainId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(dep, null, 2));
  console.log(`\nDeployment written to ${p}`);

  // Gas top-ups (Arc gas is USDC; ~$0.01/tx).
  const gas = parseEther(process.env.GAS_TOPUP_USDC || "0.5");
  const signers = ["GATEWAY_ATTESTOR_KEY", "KEEPER_KEY", "AGENT_NAIVE00_KEY", "AGENT_TREASURER01_KEY", "AGENT_TREASURER02_KEY"];
  for (const k of signers) {
    const to = account(k).address;
    const bal = await publicClient.getBalance({ address: to });
    if (bal >= gas / 2n) continue;
    const hash = await deployer.sendTransaction({ to, value: gas, chain, account: deployer.account });
    await waitOk(hash, `gas top-up ${k}`);
  }
  console.log("\nDone. Next: pnpm seed:arc");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

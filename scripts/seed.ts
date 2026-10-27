/**
 * Registers the three reference agents on the deployed protocol and funds their PolicyWallets
 * (bounty pool + treasury) with real testnet USDC from the deployer.
 *
 *   pnpm seed:arc
 */
import { keccak256, parseEther, toHex, type Address } from "viem";
import { agentRegistryAbi, erc20Abi, parseUsdc, policyWalletAbi, formatUsdc } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { AGENTS, PIPELINES, configHash } from "../apps/agents/src/definitions";
import { allowlist, mandateText } from "../apps/agents/src/fixtures";
import { signerAddress } from "../apps/agents/src/chain";
import { chain, publicClient, waitOk, wallet } from "./lib";

const dep = loadDeployment();
const owner = wallet("DEPLOYER_KEY");
const agentsUrl = (process.env.AGENTS_PUBLIC_URL || "http://localhost:8788").replace(/\/$/, "");

// NEW_AGENT_* override the .env seed amounts, and SEED_ONLY=slug,slug limits the run (used to add agents to a live deployment).
const only = (process.env.SEED_ONLY || "").split(",").filter(Boolean);
const bountyAmt = parseUsdc(process.env.NEW_AGENT_BOUNTY_USDC || process.env.SEED_BOUNTY_USDC || "12");
const treasuryAmt = parseUsdc(process.env.NEW_AGENT_TREASURY_USDC || process.env.SEED_TREASURY_USDC || "8");
const floor = parseUsdc(process.env.SEED_FLOOR_DAILY_USDC || "2");

async function main() {
  const need = (bountyAmt + treasuryAmt) * BigInt(only.length || AGENTS.length);
  const bal = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner.account.address] });
  console.log(`Owner ${owner.account.address} has ${formatUsdc(bal)} · seeding needs up to ${formatUsdc(need)}`);

  for (const a of AGENTS.filter((x) => !only.length || only.includes(x.slug))) {
    const signer = await signerAddress(a);
    // Signers pay their own gas in USDC on Arc (Circle wallets start empty).
    const gas = await publicClient.getBalance({ address: signer });
    if (gas < parseEther("0.2")) {
      await waitOk(await owner.sendTransaction({ to: signer, value: parseEther("0.5"), chain, account: owner.account }), `gas → ${a.slug} signer ${signer}`);
    }
    let id = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "agentOfSigner", args: [signer] });
    if (id === 0n) {
      const pipeline = PIPELINES[a.defaultPipeline];
      const policy = { perTxCap: parseUsdc("10"), approvalThreshold: parseUsdc("5"), windowSecs: 86400, floorDailyLimit: floor };
      const hash = await owner.writeContract({
        address: dep.registry,
        abi: agentRegistryAbi,
        functionName: "registerAgent",
        args: [
          signer,
          configHash(pipeline),
          keccak256(toHex(mandateText())),
          allowlist().root,
          `${agentsUrl}/agents/${a.slug}`,
          `${agentsUrl}/agents/${a.slug}/info`,
          policy,
        ],
        chain,
        account: owner.account,
      });
      await waitOk(hash, `register ${a.slug}`);
      id = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "agentOfSigner", args: [signer] });
    }
    const vault = (await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "vaultOf", args: [id] })) as Address;

    // Keep the on-chain configHash in sync with what this runtime actually runs (e.g. after switching LLM provider).
    const onchain = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [id] });
    const expected = configHash(PIPELINES[a.defaultPipeline]);
    if (onchain.configHash.toLowerCase() !== expected.toLowerCase()) {
      if (onchain.status === 2) {
        console.log(`  ! ${a.slug} is Breached — patch it from the owner console after the cooldown`);
      } else {
        await waitOk(
          await owner.writeContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "updateConfig", args: [id, expected], chain, account: owner.account }),
          `updateConfig ${a.slug} → ${expected.slice(0, 10)}… (tier resets, score keeps 25%)`,
        );
      }
    }
    console.log(`${a.slug}: agent #${id} vault ${vault} signer ${signer}`);

    const [pool, treasury] = await Promise.all([
      publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "bountyPool" }),
      publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "treasury" }),
    ]);
    const addBounty = pool < bountyAmt ? bountyAmt - pool : 0n;
    const addTreasury = treasury < treasuryAmt ? treasuryAmt - treasury : 0n;
    if (addBounty + addTreasury === 0n) continue;

    const approve = await owner.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [vault, addBounty + addTreasury], chain, account: owner.account });
    await waitOk(approve, `approve ${formatUsdc(addBounty + addTreasury)}`);
    if (addBounty > 0n) {
      const h = await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "depositBounty", args: [addBounty], chain, account: owner.account });
      await waitOk(h, `bounty +${formatUsdc(addBounty)}`);
    }
    if (addTreasury > 0n) {
      const h = await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "depositTreasury", args: [addTreasury], chain, account: owner.account });
      await waitOk(h, `treasury +${formatUsdc(addTreasury)}`);
    }
  }
  console.log("\nSeeded. Start services: pnpm dev:agents · pnpm dev:gateway · pnpm dev:keeper · pnpm dev:web");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * Live contract verification on the configured chain (Arc testnet by default), using a dedicated test agent
 * so the demo agents stay untouched. Every check is a real transaction or a real eth_call against the
 * deployed contracts. Ephemeral keys are saved to data/verify-keys.json so leftover funds are recoverable.
 *
 *   pnpm verify:arc
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  agentRegistryAbi,
  arenaCoreAbi,
  arenaDomain,
  attestationTypes,
  erc20Abi,
  exploitRegistryAbi,
  explorerTx,
  formatUsdc,
  intentTypes,
  parseUsdc,
  policyWalletAbi,
  policyWalletDomain,
  scoreRegistryAbi,
  type Intent,
} from "../packages/shared/src/index";
import { DATA_DIR, env, loadDeployment } from "../packages/shared/src/node";
import { allowlist, vendors } from "../apps/agents/src/fixtures";
import { account, chain, publicClient, rpcUrl, wallet } from "./lib";

const dep = loadDeployment();
const owner = wallet("DEPLOYER_KEY");
const attestor = account("GATEWAY_ATTESTOR_KEY") as PrivateKeyAccount;
const results: { name: string; ok: boolean; detail: string }[] = [];

const keys = { signer: generatePrivateKey(), attackerA: generatePrivateKey(), attackerB: generatePrivateKey() };
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, "verify-keys.json"), JSON.stringify(keys, null, 2));
const signer = privateKeyToAccount(keys.signer);
const attackerA = privateKeyToAccount(keys.attackerA);
const attackerB = privateKeyToAccount(keys.attackerB);
const client = (a: PrivateKeyAccount) => createWalletClient({ account: a, chain, transport: http(rpcUrl, { retryCount: 6, retryDelay: 1500 }) });

const vendor = vendors()[0];
const outsider = privateKeyToAccount(generatePrivateKey()).address;

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

async function send(label: string, hash: Hex) {
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== "success") throw new Error(`${label} reverted ${hash}`);
  console.log(`   tx ${label}: ${explorerTx(hash, env.chainId)}`);
  return r;
}

/** Expects an eth_call simulation to revert with a specific custom error. */
async function expectRevert(name: string, expected: string, sim: () => Promise<unknown>) {
  try {
    await sim();
    record(name, false, `expected ${expected} but call succeeded`);
  } catch (err) {
    let got = "unknown";
    if (err instanceof BaseError) {
      const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
      got = r instanceof ContractFunctionRevertedError ? (r.data?.errorName ?? r.shortMessage) : err.shortMessage;
    }
    record(name, got === expected, `reverted with ${got}`);
  }
}

let nonce = BigInt(Date.now());
function intent(agentId: bigint, to: Address, amount: bigint): Intent {
  return { agentId, to, amount, category: keccak256(toHex("SaaS")), ref: keccak256(toHex(`verify-${nonce}`)), nonce: nonce++, deadline: BigInt(Math.floor(Date.now() / 1000) + 900) };
}

async function main() {
  console.log(`Verifying live contracts on chain ${env.chainId} · registry ${dep.registry}\n`);

  // ── setup: gas for ephemeral accounts, register test agent #N, fund it ──
  for (const [who, amt] of [[signer.address, "0.3"], [attackerA.address, "1"], [attackerB.address, "1"]] as const) {
    await send(`gas → ${who.slice(0, 8)}`, await owner.sendTransaction({ to: who, value: parseEther(amt), chain, account: owner.account }));
  }
  const policy = { perTxCap: parseUsdc("10"), approvalThreshold: parseUsdc("5"), windowSecs: 86400, floorDailyLimit: parseUsdc("2") };
  const reg = await publicClient.simulateContract({
    address: dep.registry, abi: agentRegistryAbi, functionName: "registerAgent", account: owner.account,
    args: [signer.address, keccak256(toHex("verify-config")), keccak256(toHex("verify-mandate")), allowlist().root, "https://verify.arena.invalid", "https://verify.arena.invalid/meta", policy],
  });
  await send("registerAgent", await owner.writeContract(reg.request));
  const agentId = reg.result;
  const vault = (await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "vaultOf", args: [agentId] })) as Address;
  console.log(`   test agent #${agentId} vault ${vault}\n`);
  await send("approve", await owner.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [vault, parseUsdc("11")], chain, account: owner.account }));
  await send("depositBounty $6", await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "depositBounty", args: [parseUsdc("6")], chain, account: owner.account }));
  await send("depositTreasury $5", await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "depositTreasury", args: [parseUsdc("5")], chain, account: owner.account }));
  const sc = client(signer);
  const proof = allowlist().proof(vendor.address);

  // 1 · production payment within floor limit
  const before = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vendor.address] });
  await send("payProduction $1", await sc.writeContract({ address: vault, abi: policyWalletAbi, functionName: "payProduction", args: [intent(agentId, vendor.address, parseUsdc("1")), proof, "0x"], chain, account: signer }));
  const after = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vendor.address] });
  record("1. Autonomous payment within the $2 floor limit", after - before === parseUsdc("1"), `vendor received ${formatUsdc(after - before)}`);

  // 2 · over limit without owner
  const over = intent(agentId, vendor.address, parseUsdc("1.5"));
  await expectRevert("2. Over-limit payment without owner co-sign is blocked", "EscalationRequired", () =>
    publicClient.simulateContract({ address: vault, abi: policyWalletAbi, functionName: "payProduction", args: [over, proof, "0x"], account: signer }));

  // 3 · same payment with owner EIP-712 co-signature
  const sig = await owner.signTypedData({ domain: policyWalletDomain(env.chainId, vault), types: intentTypes, primaryType: "Intent", message: over, account: owner.account });
  const r3 = await send("payProduction $1.5 co-signed", await sc.writeContract({ address: vault, abi: policyWalletAbi, functionName: "payProduction", args: [over, proof, sig], chain, account: signer }));
  record("3. Same payment with owner's EIP-712 co-signature clears (escalated)", r3.status === "success", "ProductionPayment escalated=true");

  // 4 · not allowlisted
  await expectRevert("4. Payment to a non-allowlisted address is blocked", "NotAllowlisted", () =>
    publicClient.simulateContract({ address: vault, abi: policyWalletAbi, functionName: "payProduction", args: [intent(agentId, outsider, parseUsdc("0.5")), [], "0x"], account: signer }));

  // 5 · drive-by drain of bounty pool
  await expectRevert("5. Bounty payment to an address with no live session is blocked", "RecipientNotAllowed", () =>
    publicClient.simulateContract({ address: vault, abi: policyWalletAbi, functionName: "payBounty", args: [intent(agentId, outsider, parseUsdc("5")), []], account: signer }));

  // 6 · owner self-attack
  await expectRevert("6. Owner cannot attack their own agent", "BadAttacker", () =>
    publicClient.simulateContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "openSession", args: [agentId, 1, owner.account.address], account: owner.account }));

  // 7 · survived session → score + tier
  const fee = (await publicClient.readContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "tierFees" }))[1];
  await send("usdc → attackerA", await owner.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "transfer", args: [attackerA.address, fee], chain, account: owner.account }));
  const ac = client(attackerA);
  await send("approve fee", await ac.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [dep.arena, fee], chain, account: attackerA }));
  const openA = await publicClient.simulateContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "openSession", args: [agentId, 1, attackerA.address], account: attackerA });
  await send("openSession (A)", await ac.writeContract(openA.request));
  const locked = await publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "lockedBounty" });
  const att = { sid: openA.result, msgCount: 6, transcriptRoot: keccak256(toHex("verify-transcript")), endedAt: BigInt((await publicClient.getBlock()).timestamp) };
  const attSig = await attestor.signTypedData({ domain: arenaDomain(env.chainId, dep.arena), types: attestationTypes, primaryType: "Attestation", message: att });
  const grantBefore = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [dep.grantPool] });
  await send("closeSession (attested)", await owner.writeContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "closeSession", args: [att, attSig], chain, account: owner.account }));
  const [tier, score] = await publicClient.readContract({ address: dep.score, abi: scoreRegistryAbi, functionName: "standing", args: [agentId] });
  const grantAfter = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [dep.grantPool] });
  record("7. Survived session: bounty locked then released, score↑, tier T0→T1, 30% fee to GrantPool",
    locked > 0n && tier === 1 && score > 0 && grantAfter - grantBefore === fee - (fee * 7000n) / 10000n,
    `locked ${formatUsdc(locked)} · tier T${tier} · score ${score} · GrantPool +${formatUsdc(grantAfter - grantBefore)}`);

  // 8 · limit unlocked → payment that would have escalated now clears autonomously
  const limit = await publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "dailyLimit" });
  await send("payProduction $2 autonomous", await sc.writeContract({ address: vault, abi: policyWalletAbi, functionName: "payProduction", args: [intent(agentId, vendor.address, parseUsdc("2")), proof, "0x"], chain, account: signer }));
  record("8. Daily limit rose from $2 to proven bounty; $2 payment (would need owner at floor) clears on its own", limit === parseUsdc("5"), `dailyLimit now ${formatUsdc(limit)}`);

  // 9 · breach → automatic payout
  await send("usdc → attackerB", await owner.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "transfer", args: [attackerB.address, fee], chain, account: owner.account }));
  const bc = client(attackerB);
  await send("approve fee", await bc.writeContract({ address: dep.usdc, abi: erc20Abi, functionName: "approve", args: [dep.arena, fee], chain, account: attackerB }));
  const openB = await publicClient.simulateContract({ address: dep.arena, abi: arenaCoreAbi, functionName: "openSession", args: [agentId, 1, attackerB.address], account: attackerB });
  await send("openSession (B)", await bc.writeContract(openB.request));
  const bBefore = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [attackerB.address] });
  await send("payBounty → attacker (breach)", await sc.writeContract({ address: vault, abi: policyWalletAbi, functionName: "payBounty", args: [intent(agentId, attackerB.address, parseUsdc("50")), []], chain, account: signer }));
  const bAfter = await publicClient.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [attackerB.address] });
  const status = await publicClient.readContract({ address: dep.registry, abi: agentRegistryAbi, functionName: "statusOf", args: [agentId] });
  const effTier = await publicClient.readContract({ address: dep.score, abi: scoreRegistryAbi, functionName: "effectiveTier", args: [agentId] });
  record("9. Breach: contract pays the locked bounty (+fee refund) to the attacker automatically; agent Breached, tier 0",
    bAfter - bBefore === parseUsdc("5") + fee && status === 2 && effTier === 0,
    `attacker received ${formatUsdc(bAfter - bBefore)} (asked $50, capped at lock) · status ${["None", "Active", "Breached", "Suspended"][status]} · tier T${effTier}`);

  // 10 · exploit publish allowed for the discoverer (simulated, not broadcast, to keep the public corpus clean)
  try {
    await publicClient.simulateContract({ address: dep.exploits, abi: exploitRegistryAbi, functionName: "publish", args: [openB.result, "https://verify.invalid/t", keccak256(toHex("t")), keccak256(toHex("f"))], account: attackerB });
    record("10. Discoverer can publish the breach as an exploit", true, "publish() simulation succeeded (not broadcast)");
  } catch (err) {
    record("10. Discoverer can publish the breach as an exploit", false, (err as Error).message.slice(0, 120));
  }

  // ── cleanup: recover test funds to the owner ──
  const free = await publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "freeBounty" });
  if (free > 0n) await send("withdrawBounty", await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "withdrawBounty", args: [free], chain, account: owner.account }));
  const tr = await publicClient.readContract({ address: vault, abi: policyWalletAbi, functionName: "treasury" });
  if (tr > 0n) await send("withdrawTreasury", await owner.writeContract({ address: vault, abi: policyWalletAbi, functionName: "withdrawTreasury", args: [tr], chain, account: owner.account }));
  // USDC is also Arc's gas token: return the payout but keep a small native reserve for the fee.
  const bNative = await publicClient.getBalance({ address: attackerB.address });
  const reserve = parseEther("0.05");
  if (bNative > reserve) await send("return attacker payout", await bc.sendTransaction({ to: owner.account.address, value: bNative - reserve, chain, account: attackerB }));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed on chain ${env.chainId}`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * Probe: how does Circle's developer-controlled wallets API behave on Arc when asked for a LOW fee level or an
 * explicit fee below Arc's 20 gwei floor? Uses a disposable wallet (never an agent wallet). Evidence for docs/feedback-arc-circle.md.
 *   pnpm exec tsx scripts/circle-fee-probe.ts
 */
import { constants, publicEncrypt, randomUUID } from "node:crypto";
import { encodeFunctionData, parseEther, type Hex } from "viem";
import { erc20Abi } from "../packages/shared/src/index";
import { loadDeployment } from "../packages/shared/src/node";
import { chain, publicClient, waitOk, wallet } from "./lib";

const BASE = "https://api.circle.com/v1/w3s";
const key = process.env.CIRCLE_API_KEY!;
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
  const body = (await res.json().catch(() => ({}))) as { data?: T; message?: string };
  if (!res.ok || !body.data) throw new Error(`Circle ${path} → ${res.status} ${body.message ?? ""}`);
  return body.data;
}
let pub: string | null = null;
async function cipher() {
  pub ??= (await call<{ publicKey: string }>("/config/entity/publicKey")).publicKey;
  return publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(process.env.CIRCLE_ENTITY_SECRET!, "hex")).toString("base64");
}

async function run(label: string, walletId: string, to: string, data: Hex, fee: Record<string, string>, seconds: number) {
  const t0 = Date.now();
  const created = await call<{ id: string; state: string }>("/developer/transactions/contractExecution", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: randomUUID(), walletId, contractAddress: to, callData: data, ...fee, entitySecretCiphertext: await cipher() }),
  });
  console.log(`\n[${label}] created ${created.id} state=${created.state}`);
  let last = "";
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { transaction: t } = await call<{ transaction: { state: string; txHash?: Hex; errorReason?: string } }>(`/transactions/${created.id}`);
    if (t.state !== last) {
      console.log(`  +${((Date.now() - t0) / 1000).toFixed(0)}s state=${t.state}${t.txHash ? ` tx=${t.txHash}` : ""}${t.errorReason ? ` reason=${t.errorReason}` : ""}`);
      last = t.state;
    }
    if (t.txHash && ["CONFIRMED", "COMPLETE"].includes(t.state)) {
      const tx = await publicClient.getTransaction({ hash: t.txHash });
      console.log(`  → mined; on-chain maxFeePerGas=${(tx.maxFeePerGas ?? tx.gasPrice ?? 0n) / 1_000_000_000n} gwei`);
      return;
    }
    if (["FAILED", "CANCELLED", "DENIED"].includes(t.state)) return;
  }
  console.log(`  ✗ not confirmed after ${seconds}s (last state=${last})`);
}

async function main() {
  const dep = loadDeployment();
  const set = await call<{ walletSet: { id: string } }>("/developer/walletSets", { method: "POST", body: JSON.stringify({ idempotencyKey: randomUUID(), name: "feedback-probe", entitySecretCiphertext: await cipher() }) });
  const w = await call<{ wallets: { id: string; address: `0x${string}` }[] }>("/developer/wallets", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: randomUUID(), walletSetId: set.walletSet.id, blockchains: ["ARC-TESTNET"], accountType: "EOA", count: 1, entitySecretCiphertext: await cipher() }),
  });
  const probe = w.wallets[0];
  console.log(`disposable Circle wallet ${probe.id} → ${probe.address}`);
  const owner = wallet("DEPLOYER_KEY");
  await waitOk(await owner.sendTransaction({ to: probe.address, value: parseEther("0.1"), chain, account: owner.account }), "gas → probe wallet");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [probe.address, 0n] });
  await run("feeLevel=LOW", probe.id, dep.usdc, data, { feeLevel: "LOW" }, 60);
  await run("feeLevel=MEDIUM", probe.id, dep.usdc, data, { feeLevel: "MEDIUM" }, 60);
  await run("explicit maxFee=10 gwei (below the 20 gwei floor)", probe.id, dep.usdc, data, { gasLimit: "100000", maxFee: "10", priorityFee: "1" }, 75);
  console.log("\ndone (probe wallet is disposable)");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

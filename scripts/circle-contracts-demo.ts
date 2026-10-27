/**
 * Circle Contracts (Smart Contract Platform) demo: deploys a GrantPool through Circle's API from a Circle
 * developer-controlled wallet, then reads it back from the chain. Uses the disposable probe wallet by default.
 *   CIRCLE_PROBE_WALLET_ID=<wallet id> pnpm exec tsx scripts/circle-contracts-demo.ts
 */
import { constants, publicEncrypt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, loadDeployment } from "../packages/shared/src/node";
import { explorerAddress } from "../packages/shared/src/index";
import { parseEther } from "viem";
import { chain, publicClient, waitOk, wallet } from "./lib";

const BASE = "https://api.circle.com/v1/w3s";
const key = process.env.CIRCLE_API_KEY!;
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
  const body = (await res.json().catch(() => ({}))) as { data?: T; message?: string };
  if (!res.ok || !body.data) throw new Error(`Circle ${path} → ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  return body.data;
}
let pub: string | null = null;
async function cipher() {
  pub ??= (await call<{ publicKey: string }>("/config/entity/publicKey")).publicKey;
  return publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(process.env.CIRCLE_ENTITY_SECRET!, "hex")).toString("base64");
}

async function main() {
  const dep = loadDeployment();
  const walletId = process.env.CIRCLE_PROBE_WALLET_ID ?? process.env.CIRCLE_WALLET_ID_NAIVE00;
  if (!walletId) throw new Error("set CIRCLE_PROBE_WALLET_ID");
  // Circle reserves max fee × gas limit up front (≈ $0.4 for a deployment), so top up the deploying wallet first.
  const circleAddress = (await call<{ wallet: { address: `0x${string}` } }>(`/wallets/${walletId}`)).wallet.address;
  if ((await publicClient.getBalance({ address: circleAddress })) < parseEther("0.6")) {
    const owner = wallet("DEPLOYER_KEY");
    await waitOk(await owner.sendTransaction({ to: circleAddress, value: parseEther("0.6"), chain, account: owner.account }), `gas → ${circleAddress}`);
  }
  const artifact = JSON.parse(readFileSync(join(REPO_ROOT, "contracts/out/GrantPool.sol/GrantPool.json"), "utf8"));
  const created = await call<{ contractId: string; transactionId: string }>("/contracts/deploy", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      name: "ArenaGrantPool",
      description: "GrantPool deployed through the Circle Contracts API",
      walletId,
      blockchain: "ARC-TESTNET",
      abiJson: JSON.stringify(artifact.abi),
      bytecode: artifact.bytecode.object,
      constructorParameters: [dep.usdc, dep.admin],
      feeLevel: "MEDIUM",
      entitySecretCiphertext: await cipher(),
    }),
  });
  console.log(`deploy requested: contractId ${created.contractId}, tx ${created.transactionId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { contract } = await call<{ contract: { contractAddress?: string; status?: string; deployTransactionHash?: string; deploymentErrorReason?: string; deploymentErrorDetails?: string } }>(`/contracts/${created.contractId}`);
    if (contract.status === "FAILED") throw new Error(`Circle deployment failed: ${contract.deploymentErrorReason} — ${contract.deploymentErrorDetails}`);
    if (contract.contractAddress && contract.status !== "PENDING") {
      const code = await publicClient.getCode({ address: contract.contractAddress as `0x${string}` });
      console.log(`✓ deployed at ${contract.contractAddress} (status ${contract.status}); on-chain code present: ${!!code && code !== "0x"}`);
      console.log(`  ${explorerAddress(contract.contractAddress, dep.chainId)}${contract.deployTransactionHash ? `\n  deploy tx ${contract.deployTransactionHash}` : ""}`);
      return;
    }
  }
  throw new Error("deployment not confirmed after 120 s");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

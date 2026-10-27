/**
 * Circle developer-controlled wallets as agent signers (keys never live in our env).
 * Enabled per agent when CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET and CIRCLE_WALLET_ID_<SLUG> are set.
 * Request shape verified against the API reference — see docs/reference/circle.md.
 */
import { constants, publicEncrypt, randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";

const BASE = "https://api.circle.com/v1/w3s";

function apiKey(): string {
  const k = process.env.CIRCLE_API_KEY;
  if (!k) throw new Error("CIRCLE_API_KEY not set");
  return k;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; message?: string };
  if (!res.ok || !body.data) throw new Error(`Circle ${path} → ${res.status} ${body.message ?? ""}`);
  return body.data;
}

let _publicKey: string | null = null;
async function entitySecretCiphertext(): Promise<string> {
  const secret = process.env.CIRCLE_ENTITY_SECRET;
  if (!secret) throw new Error("CIRCLE_ENTITY_SECRET not set");
  if (!_publicKey) _publicKey = (await call<{ publicKey: string }>("/config/entity/publicKey")).publicKey;
  return publicEncrypt(
    { key: _publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(secret, "hex"),
  ).toString("base64");
}

export function circleWalletId(slug: string): string | undefined {
  // CIRCLE_DISABLED=1 (the local harness) makes every agent sign with its own local key, so a local chain never calls Circle.
  if (process.env.CIRCLE_DISABLED === "1" || !process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) return undefined;
  return process.env[`CIRCLE_WALLET_ID_${slug.replace(/-/g, "").toUpperCase()}`] || undefined;
}

export async function circleWalletAddress(walletId: string): Promise<Address> {
  const data = await call<{ wallet: { address: Address } }>(`/wallets/${walletId}`);
  return data.wallet.address;
}

/** Executes raw calldata against a contract from a Circle wallet and waits for the on-chain hash. */
export async function circleExecute(walletId: string, contract: Address, callData: Hex): Promise<Hex> {
  const created = await call<{ id: string }>("/developer/transactions/contractExecution", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      walletId,
      contractAddress: contract,
      callData,
      feeLevel: "MEDIUM",
      entitySecretCiphertext: await entitySecretCiphertext(),
    }),
  });
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { transaction } = await call<{ transaction: { state: string; txHash?: Hex; errorReason?: string } }>(
      `/transactions/${created.id}`,
    );
    if (transaction.txHash && ["CONFIRMED", "COMPLETE"].includes(transaction.state)) return transaction.txHash;
    if (["FAILED", "CANCELLED", "DENIED"].includes(transaction.state)) {
      throw new Error(`Circle tx ${created.id} ${transaction.state}: ${transaction.errorReason ?? ""}`);
    }
  }
  throw new Error(`Circle tx ${created.id} timed out`);
}

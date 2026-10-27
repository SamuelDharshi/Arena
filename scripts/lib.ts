import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Account,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, parseUsdc, RECEIPT_TIMEOUT_MS } from "../packages/shared/src/index";
import { env } from "../packages/shared/src/node";

/** Scripts may use a separate RPC (SCRIPT_RPC_URL) so they don't share rate limits with the running backend. */
export const rpcUrl = process.env.SCRIPT_RPC_URL || env.rpcUrl;
const transport = () => http(rpcUrl, { retryCount: 6, retryDelay: 1500 });
export const chain = chainFor(env.chainId, rpcUrl);
export const publicClient = createPublicClient({ chain, transport: transport() });

export function wallet(keyEnv: string) {
  const account = privateKeyToAccount(env.key(keyEnv));
  return createWalletClient({ account, chain, transport: transport() });
}

export function account(keyEnv: string): Account {
  return privateKeyToAccount(env.key(keyEnv));
}

export function usdcList(name: string, fallback: string): bigint[] {
  const parts = (process.env[name] || fallback).split(",").map((s) => parseUsdc(s.trim()));
  if (parts.length !== 4) throw new Error(`${name} must have 4 comma-separated values (T1..T4)`);
  return [0n, ...parts];
}

/** Deterministic fixture vendor wallets derived from VENDOR_SEED (so funds sent to them are recoverable). */
export function vendorKey(name: string): Hex {
  return keccak256(toHex(`${env.require("VENDOR_SEED")}:${name}`));
}

export async function waitOk(hash: Hex, label: string) {
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ✓ ${label}  ${hash}`);
  return r;
}

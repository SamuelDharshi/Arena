/** Node-only helpers: env loading and deployment manifest access. */
import { parse as parseDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fallback, http, type Address, type Hex, type Transport } from "viem";
import { ARC_TESTNET_USDC, arcTestnet } from "./chain";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

// .env wins over the shell for non-empty values (empty placeholders never clobber real env vars).
// ARENA_ENV=<profile> layers `.env.<profile>` on top (e.g. a local Arc fork) without touching `.env`.
const shellProfile = process.env.ARENA_ENV;
for (const f of [".env", shellProfile ? `.env.${shellProfile}` : null]) {
  if (!f) continue;
  const envFile = join(REPO_ROOT, f);
  if (!existsSync(envFile)) continue;
  for (const [k, v] of Object.entries(parseDotenv(readFileSync(envFile)))) {
    if (v !== "") process.env[k] = v;
  }
}

/** Runtime state (embedded Postgres, decision logs, escalations). Separate per profile. */
export const DATA_DIR = process.env.ARENA_DATA_DIR
  ? resolve(REPO_ROOT, process.env.ARENA_DATA_DIR)
  : join(REPO_ROOT, shellProfile ? `data-${shellProfile}` : "data");

export interface Deployment {
  chainId: number;
  usdc: Address;
  registry: Address;
  score: Address;
  arena: Address;
  grantPool: Address;
  exploits: Address;
  factory: Address;
  walletImpl: Address;
  admin: Address;
  attestor: Address;
  keeper: Address;
  demoFastTiers: boolean;
  startBlock: number;
  deployedAt: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export const env = {
  get rpcUrl(): string {
    return process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];
  },
  get chainId(): number {
    return Number(process.env.ARC_CHAIN_ID || arcTestnet.id);
  },
  get usdc(): Address {
    return (process.env.USDC_ADDRESS || ARC_TESTNET_USDC) as Address;
  },
  key(name: string): Hex {
    const v = req(name);
    return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
  },
  optional(name: string): string | undefined {
    return process.env[name] || undefined;
  },
  require: req,
  get demoFastTiers(): boolean {
    return (process.env.DEMO_FAST_TIERS ?? "true") === "true";
  },
};

export function deploymentPath(chainId = env.chainId): string {
  return join(REPO_ROOT, "deployments", `${chainId}.json`);
}

export function loadDeployment(chainId = env.chainId): Deployment {
  const p = deploymentPath(chainId);
  if (!existsSync(p)) {
    throw new Error(`No deployment for chain ${chainId} at ${p}. Run \`pnpm deploy:arc\` first.`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

export function tryLoadDeployment(chainId = env.chainId): Deployment | null {
  try {
    return loadDeployment(chainId);
  } catch {
    return null;
  }
}

/** Arc's other official testnet RPCs (docs/reference/arc.md) — used as automatic fallbacks. */
const ARC_TESTNET_FALLBACKS = ["https://rpc.drpc.testnet.arc.io", "https://rpc.blockdaemon.testnet.arc.io"];

/**
 * Rate-limit-tolerant RPC transport: the configured RPC first, then ARC_RPC_FALLBACKS (comma-separated) or
 * Arc's official alternates, each with retries. Public RPCs throttle a busy backend; this keeps it running.
 */
export function rpcTransport(): Transport {
  const extra = (process.env.ARC_RPC_FALLBACKS ?? (env.chainId === 5042002 ? ARC_TESTNET_FALLBACKS.join(",") : ""))
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u && u !== env.rpcUrl);
  const urls = [env.rpcUrl, ...extra];
  if (urls.length === 1) return http(urls[0], { retryCount: 4, retryDelay: 1000 });
  return fallback(urls.map((u) => http(u, { retryCount: 2, retryDelay: 800 })), { rank: false, retryCount: 3 });
}

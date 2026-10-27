import { defineChain, type Chain } from "viem";
import { getGasPrice } from "viem/actions";

/**
 * Arc network definitions. Facts and their sources: docs/reference/arc.md
 * (https://docs.arc.io/arc/references/connect-to-arc.md, …/evm-differences.md).
 */

/** Arc's mempool silently drops txs with maxFeePerGas < 20 gwei (no error, no receipt). */
export const ARC_MIN_FEE_PER_GAS = 20_000_000_000n;

/** Bounded receipt waits: blocklist reverts and dropped txs can produce no receipt on Arc. */
export const RECEIPT_TIMEOUT_MS = 60_000;

const arcFees = {
  async estimateFeesPerGas({ client, type }: { client: Parameters<typeof getGasPrice>[0]; type: string }) {
    const gasPrice = await getGasPrice(client);
    const padded = (gasPrice * 12n) / 10n;
    const floor = (ARC_MIN_FEE_PER_GAS * 12n) / 10n;
    const fee = padded > floor ? padded : floor;
    if (type === "legacy") return { gasPrice: fee };
    return { maxFeePerGas: fee, maxPriorityFeePerGas: 1_000_000_000n };
  },
};

/** Arc testnet — USDC is the native gas token (18 dec natively, 6 dec via the ERC-20 interface). */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"], webSocket: ["wss://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  fees: arcFees as never,
  testnet: true,
});

/** Arc mainnet. */
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
  fees: arcFees as never,
});

/** ERC-20 interface of native USDC on Arc (6 decimals over the native 18-decimal balance). */
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

const ARC_CHAINS: Record<number, Chain> = { [arcTestnet.id]: arcTestnet, [arcMainnet.id]: arcMainnet };

export function isArc(chainId: number): boolean {
  return chainId in ARC_CHAINS;
}

export function chainFor(chainId: number, rpcUrl?: string): Chain {
  const arc = ARC_CHAINS[chainId];
  if (arc) return rpcUrl ? { ...arc, rpcUrls: { default: { http: [rpcUrl] } } } : arc;
  return defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl ?? "http://127.0.0.1:8545"] } },
  });
}

function explorerBase(chainId: number): string | null {
  return ARC_CHAINS[chainId]?.blockExplorers?.default.url ?? null;
}

export function explorerTx(hash: string, chainId: number = arcTestnet.id): string {
  const base = explorerBase(chainId);
  return base ? `${base}/tx/${hash}` : `#${hash}`;
}

export function explorerAddress(addr: string, chainId: number = arcTestnet.id): string {
  const base = explorerBase(chainId);
  return base ? `${base}/address/${addr}` : `#${addr}`;
}

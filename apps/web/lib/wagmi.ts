import { http, createConfig, injected } from "wagmi";
import { chainFor } from "@arena/shared";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 5042002);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.testnet.arc.io";
export const GATEWAY = (process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8787").replace(/\/$/, "");
export const arenaChain = chainFor(CHAIN_ID, RPC_URL);

// Injected wallets only (MetaMask, Rabby, Coinbase extension…) — avoids pulling every connector SDK into the bundle.
export const wagmiConfig = createConfig({
  chains: [arenaChain],
  connectors: [injected()],
  transports: { [arenaChain.id]: http(RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

"use client";
import { useCallback, useEffect, useState } from "react";
import { BaseError, ContractFunctionRevertedError, createWalletClient, custom, type EIP1193Provider, type Hex, type TransactionReceipt, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { RECEIPT_TIMEOUT_MS } from "@arena/shared";
import { arenaChain } from "./wagmi";

function makeWallet(address: Address, provider: EIP1193Provider) {
  return createWalletClient({ account: address, chain: arenaChain, transport: custom(provider) });
}
export type ArenaWallet = ReturnType<typeof makeWallet>;

export interface TxStep {
  label: string;
  status: "pending" | "done" | "error";
  hash?: Hex;
  error?: string;
}

export function errorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.shortMessage;
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Makes sure the wallet itself is on Arc (adds the network if the wallet does not know it yet). */
export async function ensureArc(wallet: ArenaWallet): Promise<void> {
  try {
    await wallet.switchChain({ id: arenaChain.id });
  } catch {
    await wallet.addChain({ chain: arenaChain });
  }
}

/** Wallet client built from the connected wallet's own provider (see the note in the body). */
export function useArenaWallet(): ArenaWallet | undefined {
  // Build the wallet client straight from the connected wallet's provider instead of wagmi's connection state:
  // wagmi throws ConnectorChainMismatchError when its stored chain (e.g. Ethereum, id 1 from the moment of connecting)
  // differs from the wallet's real chain (Arc, 5042002) after the user switches networks in the wallet.
  const { address, connector, isConnected } = useAccount();
  const [wallet, setWallet] = useState<ArenaWallet | undefined>();
  useEffect(() => {
    let live = true;
    (async () => {
      if (!isConnected || !connector || !address) return setWallet(undefined);
      const provider = (await connector.getProvider()) as EIP1193Provider;
      if (live) setWallet(makeWallet(address, provider));
    })().catch(() => live && setWallet(undefined));
    return () => {
      live = false;
    };
  }, [isConnected, connector, address]);
  return wallet;
}

/** Imperative tx runner with a visible step log (wallet prompt → receipt). */
export function useTxRunner() {
  const publicClient = usePublicClient();
  const wallet = useArenaWallet();
  const [steps, setSteps] = useState<TxStep[]>([]);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (label: string, send: (w: ArenaWallet) => Promise<Hex>): Promise<TransactionReceipt> => {
      if (!wallet || !publicClient) throw new Error("connect a wallet first");
      setBusy(true);
      setSteps((s) => [...s, { label, status: "pending" }]);
      const patch = (p: Partial<TxStep>) => setSteps((s) => s.map((x, i) => (i === s.length - 1 ? { ...x, ...p } : x)));
      try {
        await ensureArc(wallet);
        const hash = await send(wallet);
        patch({ hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        if (receipt.status !== "success") throw new Error("transaction reverted");
        patch({ status: "done" });
        return receipt;
      } catch (err) {
        patch({ status: "error", error: errorMessage(err) });
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [wallet, publicClient],
  );

  return { run, steps, busy, reset: () => setSteps([]), ready: !!wallet && !!publicClient, publicClient, wallet };
}

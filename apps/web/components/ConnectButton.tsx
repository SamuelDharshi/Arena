"use client";
import { useEffect, useRef, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { erc20Abi, formatUsdc, shortAddr } from "@arena/shared";
import { arenaChain } from "@/lib/wagmi";
import { useConfig } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function useUsdcBalance(address?: `0x${string}`) {
  const { data: cfg } = useConfig();
  return useReadContract({
    address: cfg?.deployment.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!cfg, refetchInterval: 6000 },
  });
}

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { signOut } = useAuth();
  const { data: bal } = useUsdcBalance(address);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  if (!isConnected) {
    return (
      <div ref={ref} className="relative">
        <button className="btn-primary !py-1.5" onClick={() => (connectors.length === 1 ? connect({ connector: connectors[0] }) : setOpen((o) => !o))} disabled={isPending}>
          {isPending ? "Connecting…" : "Connect"}
        </button>
        {open && (
          <div className="panel absolute right-0 mt-2 w-56 p-1">
            {connectors.map((c) => (
              <button key={c.uid} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-ink-800" onClick={() => connect({ connector: c })}>
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (chainId !== arenaChain.id) {
    return (
      <button className="btn-danger !py-1.5" onClick={() => switchChain({ chainId: arenaChain.id })}>
        Switch to {arenaChain.name}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button className="btn-ghost !py-1.5" onClick={() => setOpen((o) => !o)}>
        <span className="num text-accent">{bal !== undefined ? formatUsdc(bal) : "…"}</span>
        <span className="font-mono text-xs text-slate-300">{shortAddr(address)}</span>
      </button>
      {open && (
        <div className="panel absolute right-0 mt-2 w-64 p-3 text-sm">
          <div className="label">Wallet</div>
          <div className="mb-3 break-all font-mono text-xs">{address}</div>
          {arenaChain.id === 5042002 && (
            <a className="btn-ghost mb-2 w-full !text-xs" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              Get testnet USDC (Circle faucet)
            </a>
          )}
          <button
            className="btn-ghost w-full !text-xs"
            onClick={() => {
              signOut();
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

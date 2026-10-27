"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "./ConnectButton";
import { useConfig } from "@/lib/api";
import { CHAIN_ID } from "@/lib/wagmi";

const LINKS = [
  { href: "/arena", label: "Arena" },
  { href: "/exploits", label: "Exploits" },
  { href: "/owner", label: "Owners" },
  { href: "/demo", label: "Judge mode" },
];

export function Nav() {
  const path = usePathname();
  const { data: cfg } = useConfig();
  const light = true;
  return (
    <header className={`sticky top-0 z-40 border-b backdrop-blur ${light ? "border-leaf-100 bg-black/90 text-leaf-950" : "border-ink-700/80 bg-ink-950/85"}`}>
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <img src="/images/logo.png" alt="Arena" className="h-10 w-10 rounded-lg" />
          <span className={`hidden sm:inline ${light ? "font-heading font-bold" : ""}`}>Arena</span>
        </Link>
        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm">
          {LINKS.map((l) => {
            const on = path.startsWith(l.href) || (l.href === "/arena" && (path.startsWith("/agent") || path.startsWith("/attack")));
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 transition ${
                  on ? "bg-leaf-50 font-semibold text-leaf-800" : "text-leaf-800 hover:bg-leaf-50"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <span className={`hidden items-center gap-1.5 rounded-full border border-accent/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-accent md:inline-flex`}>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {CHAIN_ID === 5042002 ? "Arc testnet USDC" : `Local chain ${CHAIN_ID} · test token`}
          {cfg?.deployment.demoFastTiers ? " · fast tiers" : ""}
        </span>
        <div className={light ? "landing-connect" : ""}>
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

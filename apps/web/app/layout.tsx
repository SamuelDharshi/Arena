import type { Metadata, Viewport } from "next";
import { Cinzel, JetBrains_Mono, Playfair_Display, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";
import { MetricsFooter } from "@/components/MetricsFooter";

const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const italic = Playfair_Display({ subsets: ["latin"], weight: ["700", "800"], style: ["italic"], variable: "--font-italic", display: "swap" });
const heading = Cinzel({ subsets: ["latin"], weight: ["700", "900"], variable: "--font-heading", display: "swap" });

export const metadata: Metadata = {
  title: "Arena — break the agent, keep the bounty",
  description:
    "A live-fire range where anyone can try to rob an AI agent's wallet. Breach it and the contract pays you; fail and the agent's on-chain score — and spending limit — goes up. Settled in USDC on Arc.",
};

export const viewport: Viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} ${heading.variable} ${italic.variable}`}>
      <body className="min-h-screen">
        <Providers>
          <Nav />
          <main className="mx-auto w-full max-w-[1400px] px-4 pb-24 sm:px-6">{children}</main>
          <MetricsFooter />
        </Providers>
      </body>
    </html>
  );
}

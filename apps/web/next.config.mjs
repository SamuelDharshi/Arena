// Loads NEXT_PUBLIC_* from the repo-root .env (and .env.<ARENA_ENV>) so one config drives every app.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const profile = process.env.ARENA_ENV;
const merged = {};
for (const f of [".env", profile ? `.env.${profile}` : null]) {
  if (f && existsSync(join(root, f))) {
    for (const [k, v] of Object.entries(parse(readFileSync(join(root, f))))) if (v !== "") merged[k] = v;
  }
}
const env = {
  NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL || merged.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:8787",
  NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID || merged.ARC_CHAIN_ID || "5042002",
  NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL || merged.ARC_RPC_URL || "https://rpc.testnet.arc.io",
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@arena/shared"],
  env,
  webpack: (config) => {
    // wagmi optional peer deps not used in the browser build
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};
export default nextConfig;

/**
 * Creates `.env` from `.env.example` and fills in fresh testnet-only keys for every protocol role.
 * Existing values are never overwritten.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { REPO_ROOT } from "../packages/shared/src/node";

const envPath = join(REPO_ROOT, ".env");
const examplePath = join(REPO_ROOT, ".env.example");
let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(examplePath, "utf8");

const KEYS = [
  "DEPLOYER_KEY",
  "GATEWAY_ATTESTOR_KEY",
  "KEEPER_KEY",
  "AGENT_NAIVE00_KEY",
  "AGENT_TREASURER01_KEY",
  "AGENT_TREASURER02_KEY",
  "AGENT_CLERK03_KEY",
  "AGENT_AUDITOR04_KEY",
  "AGENT_SENTINEL05_KEY",
];

function setVar(name: string, value: string) {
  const re = new RegExp(`^${name}=.*$`, "m");
  const current = text.match(re)?.[0]?.split("=")[1]?.split("#")[0]?.trim();
  if (current) return false;
  if (re.test(text)) text = text.replace(re, `${name}=${value}`);
  else text += `\n${name}=${value}`;
  return true;
}

for (const k of KEYS) {
  if (setVar(k, generatePrivateKey())) console.log(`+ ${k}`);
}
if (setVar("VENDOR_SEED", randomBytes(16).toString("hex"))) console.log("+ VENDOR_SEED");
if (setVar("GATEWAY_JWT_SECRET", randomBytes(32).toString("hex"))) console.log("+ GATEWAY_JWT_SECRET");

writeFileSync(envPath, text);

console.log("\nAddresses (fund DEPLOYER with testnet USDC at https://faucet.circle.com → Arc Testnet):");
for (const k of KEYS) {
  const v = text.match(new RegExp(`^${k}=(0x[0-9a-fA-F]{64})`, "m"))?.[1];
  if (v) console.log(`  ${k.padEnd(24)} ${privateKeyToAccount(v as `0x${string}`).address}`);
}

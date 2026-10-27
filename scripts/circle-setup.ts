/**
 * Circle developer-controlled wallets for the reference agents (docs/reference/circle.md).
 *   1. generates + registers an entity secret (if CIRCLE_ENTITY_SECRET is empty) — saves the recovery file to data/
 *   2. creates a wallet set and one ARC-TESTNET EOA wallet per agent
 *   3. writes CIRCLE_ENTITY_SECRET and CIRCLE_WALLET_ID_<AGENT> into .env
 * Run BEFORE `pnpm seed:arc` so the agents register their Circle wallet addresses as signers.
 *
 *   pnpm circle:setup
 */
import { constants, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../packages/shared/src/node";

const BASE = "https://api.circle.com/v1/w3s";
const ENV = join(REPO_ROOT, ".env");
const AGENTS = ["NAIVE00", "TREASURER01", "TREASURER02", "CLERK03", "AUDITOR04", "SENTINEL05"];

const key = process.env.CIRCLE_API_KEY;
if (!key) {
  console.error("Set CIRCLE_API_KEY in .env first (format TEST_API_KEY:<id>:<secret>).");
  process.exit(1);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; message?: string; code?: number };
  if (!res.ok) throw new Error(`Circle ${init?.method ?? "GET"} ${path} → ${res.status} ${body.message ?? ""} (${body.code ?? ""})`);
  return body.data as T;
}

let publicKey: string | null = null;
async function cipher(secretHex: string): Promise<string> {
  publicKey ??= (await call<{ publicKey: string }>("/config/entity/publicKey")).publicKey;
  return publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(secretHex, "hex")).toString("base64");
}

function setEnv(name: string, value: string) {
  let text = readFileSync(ENV, "utf8");
  const re = new RegExp(`^${name}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
  writeFileSync(ENV, text);
}

async function main() {
  let secret = process.env.CIRCLE_ENTITY_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    console.log("Registering a new entity secret with Circle…");
    const r = await call<{ recoveryFile?: string }>("/config/entity/entitySecret", {
      method: "POST",
      body: JSON.stringify({ entitySecretCiphertext: await cipher(secret) }),
    });
    mkdirSync(join(REPO_ROOT, "data"), { recursive: true });
    if (r?.recoveryFile) writeFileSync(join(REPO_ROOT, "data", "circle-recovery-file.dat"), r.recoveryFile);
    setEnv("CIRCLE_ENTITY_SECRET", secret);
    console.log("  ✓ entity secret registered (recovery file: data/circle-recovery-file.dat — keep it safe)");
  }

  const missing = AGENTS.filter((a) => !process.env[`CIRCLE_WALLET_ID_${a}`]);
  if (!missing.length) {
    console.log("All agent wallet IDs already set in .env.");
    return;
  }

  const set = await call<{ walletSet: { id: string } }>("/developer/walletSets", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: randomUUID(), name: "arena", entitySecretCiphertext: await cipher(secret) }),
  });
  console.log(`  ✓ wallet set ${set.walletSet.id}`);

  const created = await call<{ wallets: { id: string; address: string; blockchain: string }[] }>("/developer/wallets", {
    method: "POST",
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      walletSetId: set.walletSet.id,
      blockchains: ["ARC-TESTNET"],
      accountType: "EOA",
      count: missing.length,
      entitySecretCiphertext: await cipher(secret),
    }),
  });
  created.wallets.forEach((w, i) => {
    setEnv(`CIRCLE_WALLET_ID_${missing[i]}`, w.id);
    console.log(`  ✓ ${missing[i].padEnd(12)} ${w.address} (${w.blockchain})`);
  });
  console.log("\nCircle wallets ready. Seeding will register these addresses as the agents' signers and give them gas.");
  if (!existsSync(ENV)) throw new Error(".env missing");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

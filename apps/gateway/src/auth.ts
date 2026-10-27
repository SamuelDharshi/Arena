/** Sign-In-With-Ethereum + compact HMAC session tokens. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, type Address } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import type { FastifyRequest } from "fastify";
import type { Db } from "@arena/db";
import { env } from "@arena/shared/node";
import { publicClient } from "./chain";

const SECRET = process.env.GATEWAY_JWT_SECRET || randomBytes(32).toString("hex");
const TTL = 24 * 3600;

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export function issueToken(addr: Address): string {
  const payload = b64(JSON.stringify({ addr, exp: Math.floor(Date.now() / 1000) + TTL }));
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string | undefined): Address | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const { addr, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { addr: Address; exp: number };
  if (exp < Date.now() / 1000) return null;
  return getAddress(addr);
}

export function authAddress(req: FastifyRequest): Address | null {
  const h = req.headers.authorization;
  const q = (req.query as Record<string, string> | undefined)?.token;
  return verifyToken(h?.startsWith("Bearer ") ? h.slice(7) : q);
}

export async function newNonce(db: Db): Promise<string> {
  const nonce = generateSiweNonce();
  await db.query(`INSERT INTO auth_nonces(nonce, created_at) VALUES ($1, $2)`, [nonce, Math.floor(Date.now() / 1000)]);
  return nonce;
}

export async function verifySiwe(db: Db, message: string, signature: `0x${string}`): Promise<Address> {
  const parsed = parseSiweMessage(message);
  if (!parsed.nonce || !parsed.address) throw new Error("malformed SIWE message");
  if (parsed.chainId && parsed.chainId !== env.chainId) throw new Error(`wrong chain (expected ${env.chainId})`);
  const used = await db.query(`DELETE FROM auth_nonces WHERE nonce = $1 AND created_at > $2 RETURNING nonce`, [
    parsed.nonce,
    Math.floor(Date.now() / 1000) - 600,
  ]);
  if (!used.length) throw new Error("unknown or expired nonce");
  // Supports EOAs and smart-contract wallets (ERC-1271 / ERC-6492).
  const ok = await publicClient.verifySiweMessage({ message, signature, nonce: parsed.nonce });
  if (!ok) throw new Error("invalid signature");
  return getAddress(parsed.address);
}

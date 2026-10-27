/**
 * Why does Zetaris say "Not Allowed"? Sends the same harmless request (list databases) with different credentials and
 * prints each answer, so you can see which failures the API tells apart and which it collapses into one message.
 *   pnpm exec tsx scripts/zetaris-diagnose.ts
 * Needs ZETARIS_ORG_ID and ZETARIS_API_KEY in .env. Nothing is written; every request is a GET.
 */
import "@arena/shared/node";
import { randomUUID } from "node:crypto";

const base = (process.env.ZETARIS_BASE_URL || "https://api.saas.enterprise.zetaris.com").replace(/\/$/, "");
const key = process.env.ZETARIS_API_KEY ?? "";
const org = process.env.ZETARIS_ORG_ID ?? "";

async function send(label: string, headers: Record<string, string>, path = "/api/v1.0/lightning-database/databases") {
  const res = await fetch(base + path, { headers: { accept: "application/json", "X-Request-ID": randomUUID(), ...headers }, signal: AbortSignal.timeout(20_000) });
  const text = (await res.text()).replace(/\s+/g, " ").slice(0, 110);
  console.log(`${String(res.status).padEnd(4)} ${label.padEnd(36)} ${text}`);
  return `${res.status} ${text}`;
}

async function main() {
  if (!key || !org) throw new Error("set ZETARIS_ORG_ID and ZETARIS_API_KEY in .env");
  console.log(`GET ${base}/api/v1.0/lightning-database/databases\n`);
  await send("no Authorization header", { "X-Org-ID": org });
  await send("no X-Org-ID header", { Authorization: `Bearer ${key}` });
  const mine = await send("your API key + your org", { Authorization: `Bearer ${key}`, "X-Org-ID": org });
  const wrongOrg = await send("your API key + a wrong org (999999)", { Authorization: `Bearer ${key}`, "X-Org-ID": "999999" });
  const fakeKey = await send("a made-up key + your org", { Authorization: "Bearer not-a-real-key", "X-Org-ID": org });
  await send("login endpoint, no credentials", { "X-Org-ID": org }, "/api/v1.0/auth/login");

  console.log("");
  if (mine === wrongOrg && mine === fakeKey) {
    console.log("Your credentials get the SAME answer as a made-up key and a wrong org: the API cannot tell you which part is wrong.");
    console.log("Check the API key and org id in the Zetaris console, or ask Zetaris to enable API access for your org.");
  } else if (mine.startsWith("200")) {
    console.log("Your credentials work.");
  } else {
    console.log("Your credentials are answered differently from a made-up key: see the table above.");
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

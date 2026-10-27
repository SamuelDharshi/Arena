/**
 * Runs the federated payee query on Zetaris for one address and prints what came back (or the exact error).
 *   pnpm exec tsx scripts/zetaris-check.ts [0xAddress]
 */
import { zetarisConfigured, zetarisRow } from "../apps/agents/src/evidence";

async function main() {
  if (!zetarisConfigured()) throw new Error("set ZETARIS_ORG_ID and ZETARIS_API_KEY in .env");
  const address = process.argv[2] ?? "0xac13a62FC7E50d08945ba2e79B5Eaa190d8D7D9a";
  console.log(`querying Zetaris for ${address} …`);
  console.log(JSON.stringify(await zetarisRow(address), null, 2));
}
main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});

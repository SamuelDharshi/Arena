/**
 * Remembers every already-settled session in the shared attack memory (run once after enabling memory, or any time
 * to catch up). Safe to repeat: a session is stored once.   pnpm memory:backfill
 */
import { getDb } from "@arena/db";
import { memoryOverDb } from "@arena/memory";
import { rememberSession } from "../apps/keeper/src/memory";

const db = await getDb();
const sessions = await db.query<{ id: string }>(`SELECT id FROM sessions WHERE state IN (2,3,4) ORDER BY id`);
let n = 0;
for (const s of sessions) if (await rememberSession(db, s.id, () => undefined)) n++;
const ledger = await memoryOverDb(db).verifyLedger();
console.log(`remembered ${n} of ${sessions.length} settled sessions · audit ledger ${ledger.ok ? "verified" : "BROKEN at " + ledger.badId} (${ledger.checked} records)`);
await db.close();

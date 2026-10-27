/**
 * Keeper: indexer (2s) · expiry closer (15s) · Gauntlet runner · agent refresh + metrics rollup (30s).
 * Runs embedded in the gateway (default with PGlite) or standalone via `pnpm dev:keeper`.
 */
import type { Db } from "@arena/db";
import { rollupMetrics } from "@arena/db";
import { arenaCoreAbi, RECEIPT_TIMEOUT_MS } from "@arena/shared";
import { chain, dep, keeperAccount, keeperWallet, publicClient } from "./chain";
import { enqueueGauntlet, processGauntletJobs } from "./gauntlet";
import { Indexer, refreshAgent } from "./indexer";

export { refreshAgent } from "./indexer";
export { replay } from "./gauntlet";

type Logger = (m: string) => void;

const GATEWAY_URL = (process.env.GATEWAY_INTERNAL_URL || process.env.GATEWAY_PUBLIC_URL || `http://localhost:${process.env.GATEWAY_PORT || 8787}`).replace(/\/$/, "");

function loop(name: string, ms: number, fn: () => Promise<unknown>, log: Logger) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log(`${name}: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(run, ms);
}

/** Closes sessions past expiry: attested close (via gateway) when there was effort, else expireStale (refund). */
async function closeExpired(db: Db, log: Logger) {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  const now = Number(block.timestamp);
  const stale = await db.query<{ id: string; msg_count: number }>(
    `SELECT id, msg_count FROM sessions WHERE state = 1 AND expires_at < $1 ORDER BY id LIMIT 20`,
    [now],
  );
  for (const s of stale) {
    const chainS = await publicClient.readContract({ address: dep().arena, abi: arenaCoreAbi, functionName: "getSession", args: [BigInt(s.id)] });
    if (chainS.state !== 1) continue; // indexer will catch up
    let attested = false;
    if (s.msg_count > 0) {
      const res = await fetch(`${GATEWAY_URL}/v1/sessions/${s.id}/end`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      attested = res.ok;
      log(`closer: attested close of session #${s.id} → ${res.status}`);
    }
    if (!attested) {
      const hash = await keeperWallet.writeContract({
        address: dep().arena,
        abi: arenaCoreAbi,
        functionName: "expireStale",
        args: [BigInt(s.id)],
        chain,
        account: keeperAccount,
      });
      await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      log(`closer: expired idle session #${s.id} (fee refunded) ${hash}`);
    }
  }
}

/** Breaches that happened outside the gateway relay (e.g. a direct AAP call) still become public exploits. */
async function publishOrphanBreaches(db: Db, log: Logger) {
  const rows = await db.query<{ id: string }>(
    `SELECT s.id FROM sessions s LEFT JOIN exploits e ON e.session_id = s.id
      WHERE s.state = 2 AND e.id IS NULL AND COALESCE(s.closed_at, 0) < $1
        AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'attacker')
      ORDER BY s.id LIMIT 5`,
    [Math.floor(Date.now() / 1000) - 20],
  );
  for (const r of rows) {
    const res = await fetch(`${GATEWAY_URL}/v1/sessions/${r.id}/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    log(`publisher: session #${r.id} → ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
}

export async function startKeeper(db: Db, opts: { log?: Logger } = {}) {
  const log = opts.log ?? ((m: string) => console.log(`[keeper] ${m}`));
  const indexer = new Indexer(db, log, {
    onExploit: (id) => void enqueueGauntlet(db, { exploitId: id }),
    // A patched agent is re-tested against every exploit it has not passed.
    onConfigChange: (agentId) => void enqueueGauntlet(db, { exploitId: "*", agentId, manual: true }),
  });

  const pollMs = Number(process.env.KEEPER_POLL_MS || 2000);
  loop("indexer", pollMs, async () => {
    const n = await indexer.tick();
    if (n) log(`indexed ${n} events`);
  }, log);
  // KEEPER_DISABLED=1 (dev gateway next to a hosted one): keep indexing so the UI stays current, but do not close
  // sessions or run Gauntlet replays. A keeper whose database lacks a session's transcript would expire it as idle.
  if (process.env.KEEPER_DISABLED !== "1") {
    loop("closer", 15_000, async () => {
      await closeExpired(db, log);
      await publishOrphanBreaches(db, log);
    }, log);
    loop("gauntlet", 5_000, () => processGauntletJobs(db, log), log);
  }
  loop("refresh", 30_000, async () => {
    const agents = await db.query<{ id: string }>(`SELECT id FROM agents`);
    for (const a of agents) await refreshAgent(db, BigInt(a.id));
    await rollupMetrics(db, dep().admin);
  }, log);
  log(`started · keeper ${keeperAccount.address} · registry ${dep().registry}`);
}

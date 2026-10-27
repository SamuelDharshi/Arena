/**
 * Chain indexer: polls Arc logs for all protocol contracts + every agent vault, upserts Postgres,
 * and refreshes cached agent state (standing, limits, balances) straight from the contracts.
 */
import { decodeEventLog, type Abi, type Address, type Log } from "viem";
import type { Db } from "@arena/db";
import {
  agentRegistryAbi,
  arenaCoreAbi,
  exploitRegistryAbi,
  grantPoolAbi,
  policyWalletAbi,
  scoreRegistryAbi,
} from "@arena/shared";
import { dep, publicClient } from "./chain";

type Logger = (m: string) => void;

const CURSOR = "indexer";
let maxRange = BigInt(process.env.INDEXER_MAX_RANGE || 5000);

interface Decoded {
  contract: string;
  name: string;
  args: Record<string, unknown>;
  log: Log;
}

const blockTs = new Map<bigint, number>();
async function tsOf(block: bigint): Promise<number> {
  const hit = blockTs.get(block);
  if (hit) return hit;
  const b = await publicClient.getBlock({ blockNumber: block });
  const t = Number(b.timestamp);
  blockTs.set(block, t);
  if (blockTs.size > 5000) blockTs.clear();
  return t;
}

function decode(abi: Abi, contract: string, log: Log): Decoded | null {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
    return { contract, name: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown>, log };
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : (v as string));
const jsonArgs = (a: Record<string, unknown>) => JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

async function getLogsChunked(address: Address[], from: bigint, to: bigint): Promise<Log[]> {
  if (!address.length) return [];
  try {
    return await publicClient.getLogs({ address, fromBlock: from, toBlock: to });
  } catch (err) {
    if (to - from < 10n) throw err;
    maxRange = (to - from) / 2n;
    const mid = from + maxRange;
    return [...(await getLogsChunked(address, from, mid)), ...(await getLogsChunked(address, mid + 1n, to))];
  }
}

export class Indexer {
  private touched = new Set<string>();
  private onExploit: (id: string) => void;
  private onConfigChange: (agentId: string) => void;

  constructor(
    private db: Db,
    private log: Logger,
    hooks: { onExploit: (id: string) => void; onConfigChange: (agentId: string) => void },
  ) {
    this.onExploit = hooks.onExploit;
    this.onConfigChange = hooks.onConfigChange;
  }

  async cursor(): Promise<bigint> {
    const row = await this.db.one<{ last_block: string }>(`SELECT last_block FROM chain_cursor WHERE name = $1`, [CURSOR]);
    return row ? BigInt(row.last_block) : BigInt(dep().startBlock) - 1n;
  }

  async tick(): Promise<number> {
    const d = dep();
    const latest = await publicClient.getBlockNumber();
    let from = (await this.cursor()) + 1n;
    let processed = 0;
    while (from <= latest) {
      const to = from + maxRange - 1n < latest ? from + maxRange - 1n : latest;
      const protocol = await getLogsChunked([d.registry, d.arena, d.score, d.exploits, d.grantPool], from, to);
      const decoded: Decoded[] = [];
      for (const l of protocol) {
        const a = l.address.toLowerCase();
        const abi =
          a === d.registry.toLowerCase() ? agentRegistryAbi
          : a === d.arena.toLowerCase() ? arenaCoreAbi
          : a === d.score.toLowerCase() ? scoreRegistryAbi
          : a === d.exploits.toLowerCase() ? exploitRegistryAbi
          : grantPoolAbi;
        const name = a === d.registry.toLowerCase() ? "AgentRegistry" : a === d.arena.toLowerCase() ? "ArenaCore" : a === d.score.toLowerCase() ? "ScoreRegistry" : a === d.exploits.toLowerCase() ? "ExploitRegistry" : "GrantPool";
        const x = decode(abi as Abi, name, l);
        if (x) decoded.push(x);
      }
      // Register agents first so vaults created in this range are included in the vault scan.
      for (const e of decoded.filter((e) => e.name === "AgentRegistered")) await this.apply(e);

      const vaults = (await this.db.query<{ vault: string }>(`SELECT vault FROM agents`)).map((r) => r.vault as Address);
      const vaultLogs = await getLogsChunked(vaults, from, to);
      for (const l of vaultLogs) {
        const x = decode(policyWalletAbi as Abi, "PolicyWallet", l);
        if (x) decoded.push(x);
      }
      decoded.sort((a, b) => Number(a.log.blockNumber! - b.log.blockNumber!) || a.log.logIndex! - b.log.logIndex!);
      for (const e of decoded) {
        if (e.name !== "AgentRegistered") await this.apply(e);
      }
      for (const id of this.touched) await refreshAgent(this.db, BigInt(id)).catch((err) => this.log(`refresh #${id}: ${err.message}`));
      this.touched.clear();

      await this.db.query(
        `INSERT INTO chain_cursor(name, last_block) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET last_block = EXCLUDED.last_block`,
        [CURSOR, to.toString()],
      );
      processed += decoded.length;
      from = to + 1n;
    }
    return processed;
  }

  private async apply(e: Decoded) {
    const { args, log } = e;
    const tx = log.transactionHash!;
    const ts = await tsOf(log.blockNumber!);
    const agentId = args.agentId !== undefined ? str(args.agentId) : args.victimAgentId !== undefined ? str(args.victimAgentId) : null;
    const id = `${tx}:${log.logIndex}`;
    const inserted = await this.db.query(
      `INSERT INTO events(id, contract, name, agent_id, args, block, log_index, tx, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, e.contract, e.name, agentId, jsonArgs(args), log.blockNumber!.toString(), log.logIndex, tx, ts],
    );
    if (!inserted.length) return; // already applied
    if (agentId) this.touched.add(agentId);

    const db = this.db;
    switch (e.name) {
      case "AgentRegistered": {
        await db.query(
          `INSERT INTO agents(id, owner, signer, vault, config_hash, registered_at, config_changed_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$6) ON CONFLICT (id) DO NOTHING`,
          [str(args.agentId), args.owner, args.signer, args.vault, args.configHash, ts],
        );
        this.touched.add(str(args.agentId));
        break;
      }
      case "ConfigUpdated":
        await db.query(`UPDATE agents SET config_hash = $2, config_changed_at = $3 WHERE id = $1`, [str(args.agentId), args.newHash, ts]);
        this.onConfigChange(str(args.agentId));
        break;
      case "SessionOpened":
        await db.query(
          `INSERT INTO sessions(id, agent_id, attacker, opener, tier, locked, fee, state, opened_at, expires_at, open_tx)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET open_tx = EXCLUDED.open_tx`,
          [str(args.sid), str(args.agentId), args.attacker, args.opener, Number(args.tier), str(args.lockedBounty), str(args.fee), ts, str(args.expiresAt), tx],
        );
        break;
      case "Breach":
        await db.query(`UPDATE sessions SET state = 2, payout = $2, breach_tx = $3, closed_at = $4 WHERE id = $1`, [str(args.sid), str(args.payout), tx, ts]);
        await db.query(`UPDATE agents SET last_breach_at = $2 WHERE id = $1`, [str(args.agentId), ts]);
        break;
      case "SessionSurvived":
        await db.query(`UPDATE sessions SET state = 3, msg_count = $2, transcript_root = $3, close_tx = $4, closed_at = $5 WHERE id = $1`, [
          str(args.sid), Number(args.msgCount), args.transcriptRoot, tx, ts,
        ]);
        break;
      case "SessionExpired":
        await db.query(`UPDATE sessions SET state = 4, close_tx = $2, closed_at = $3 WHERE id = $1`, [str(args.sid), tx, ts]);
        break;
      case "StandingUpdated":
        await db.query(
          `INSERT INTO standing_history(id, agent_id, tier, score, valid_until, tx, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [id, str(args.agentId), Number(args.tier), Number(args.score), str(args.validUntil), tx, ts],
        );
        break;
      case "ExploitPublished": {
        const sess = await publicClient.readContract({ address: dep().exploits, abi: exploitRegistryAbi, functionName: "getExploit", args: [args.exploitId as bigint] });
        await db.query(
          `INSERT INTO exploits(id, session_id, victim_agent_id, discoverer, transcript_hash, transcript_uri, fixture_hash, severity, published_at, tx)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [str(args.exploitId), str(sess.sid), str(args.victimAgentId), args.discoverer, args.transcriptHash, args.transcriptURI, sess.fixtureHash, Number(args.severity), ts, tx],
        );
        // Mirror the on-chain result matrix (pending for every Active agent at publish time).
        const agents = await db.query<{ id: string }>(`SELECT id FROM agents`);
        for (const a of agents) {
          const r = await publicClient.readContract({ address: dep().exploits, abi: exploitRegistryAbi, functionName: "results", args: [args.exploitId as bigint, BigInt(a.id)] });
          const result = ["none", "pending", "passed", "failed"][Number(r)];
          if (result === "none") continue;
          await db.query(
            `INSERT INTO gauntlet_results(exploit_id, agent_id, result, ts) VALUES ($1,$2,$3,$4)
             ON CONFLICT (exploit_id, agent_id) DO UPDATE SET result = EXCLUDED.result, ts = EXCLUDED.ts`,
            [str(args.exploitId), a.id, result, ts],
          );
          this.touched.add(a.id);
        }
        this.onExploit(str(args.exploitId));
        break;
      }
      case "DiscovererBonus":
        await db.query(`UPDATE exploits SET bonus = $2 WHERE id = $1`, [str(args.exploitId), str(args.amount)]);
        break;
      case "GauntletResult":
        await db.query(
          `INSERT INTO gauntlet_results(exploit_id, agent_id, result, run_hash, tx, ts) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (exploit_id, agent_id) DO UPDATE SET result = EXCLUDED.result, run_hash = EXCLUDED.run_hash, tx = EXCLUDED.tx, ts = EXCLUDED.ts`,
          [str(args.exploitId), str(args.agentId), args.passed ? "passed" : "failed", args.runHash, tx, ts],
        );
        break;
      case "ProductionPayment":
        await db.query(
          `INSERT INTO payments(id, agent_id, kind, to_addr, amount, category, ref, escalated, tx, ts) VALUES ($1,$2,'production',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [id, str(args.agentId), args.to, str(args.amount), args.category, args.ref, args.escalated, tx, ts],
        );
        break;
      case "VendorPaidFromBounty":
        await db.query(
          `INSERT INTO payments(id, agent_id, kind, to_addr, amount, ref, tx, ts) VALUES ($1,$2,'vendor_bounty',$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [id, str(args.agentId), args.to, str(args.amount), args.ref, tx, ts],
        );
        break;
      case "BountyPaid":
        await db.query(
          `INSERT INTO payments(id, agent_id, kind, to_addr, amount, session_id, tx, ts) VALUES ($1,$2,'bounty_payout',$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [id, str(args.agentId), args.to, str(args.payout), str(args.sid), tx, ts],
        );
        break;
    }
  }
}

/** Re-reads an agent's authoritative state from the contracts into the cache row. */
export async function refreshAgent(db: Db, agentId: bigint) {
  const d = dep();
  const a = await publicClient.readContract({ address: d.registry, abi: agentRegistryAbi, functionName: "getAgent", args: [agentId] });
  const [standing, eff, stats, pool, locked, treasury, limit, spent] = await Promise.all([
    publicClient.readContract({ address: d.score, abi: scoreRegistryAbi, functionName: "standing", args: [agentId] }),
    publicClient.readContract({ address: d.score, abi: scoreRegistryAbi, functionName: "effectiveTier", args: [agentId] }),
    publicClient.readContract({ address: d.score, abi: scoreRegistryAbi, functionName: "stats", args: [agentId] }),
    publicClient.readContract({ address: a.vault, abi: policyWalletAbi, functionName: "bountyPool" }),
    publicClient.readContract({ address: a.vault, abi: policyWalletAbi, functionName: "lockedBounty" }),
    publicClient.readContract({ address: a.vault, abi: policyWalletAbi, functionName: "treasury" }),
    publicClient.readContract({ address: a.vault, abi: policyWalletAbi, functionName: "dailyLimit" }),
    publicClient.readContract({ address: a.vault, abi: policyWalletAbi, functionName: "spentInWindow" }),
  ]);
  const [tier, score, validUntil, gauntletDeadline] = standing;
  const [credits, breaches] = stats;

  let name: string | null = null;
  let description: string | null = null;
  try {
    const meta = (await (await fetch(a.metadataURI, { signal: AbortSignal.timeout(4000) })).json()) as { name?: string; description?: string };
    name = meta.name ?? null;
    description = meta.description ?? null;
  } catch {
    /* metadata optional */
  }

  await db.query(
    `UPDATE agents SET owner=$2, signer=$3, vault=$4, config_hash=$5, mandate_hash=$6, allowlist_root=$7, endpoint=$8, metadata_uri=$9,
       status=$10, tier=$11, effective_tier=$12, score=$13, valid_until=$14, gauntlet_deadline=$15, daily_limit=$16, spent_window=$17,
       bounty_pool=$18, locked_bounty=$19, treasury=$20, credits=$21, breaches=$22, config_changed_at=$23,
       name = COALESCE($24, name, $25), description = COALESCE($26, description), updated_at=$27
     WHERE id=$1`,
    [
      agentId.toString(), a.owner, a.signer, a.vault, a.configHash, a.mandateHash, a.allowlistRoot, a.endpoint, a.metadataURI,
      a.status, tier, eff, score, validUntil.toString(), gauntletDeadline.toString(), limit.toString(), spent.toString(),
      pool.toString(), locked.toString(), treasury.toString(), credits, breaches, Number(a.configChangedAt),
      name, `Agent #${agentId}`, description, Math.floor(Date.now() / 1000),
    ],
  );
}

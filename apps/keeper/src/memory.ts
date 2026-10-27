/** After a session settles, remember what the attacker tried and what the agent did, in the shared attack memory. */
import type { Db } from "@arena/db";
import { memoryOverDb, type AttackChannel } from "@arena/memory";
import type { Decision, InboxItem } from "@arena/shared";

type Logger = (m: string) => void;

interface SessionRow {
  id: string;
  agent_id: string;
  state: number;
  break_tx: string | null;
  close_tx: string | null;
  endpoint: string | null;
  name: string | null;
}

/** "https://host/agents/naive-00" → "naive-00". Falls back to the agent id. */
function slugOf(row: SessionRow): string {
  const m = row.endpoint?.match(/\/agents\/([^/?#]+)/);
  return m ? m[1] : `agent-${row.agent_id}`;
}

function channelOf(items: InboxItem[]): AttackChannel {
  const last = items[items.length - 1]?.type;
  return last === "invoice" || last === "email" ? last : "chat";
}

/** Returns the memory id, or null when the session has nothing worth remembering (no attacker messages). */
export async function rememberSession(db: Db, sessionId: string, log: Logger): Promise<string | null> {
  const row = await db.one<SessionRow>(
    `SELECT s.id, s.agent_id, s.state, s.breach_tx AS break_tx, s.close_tx, a.endpoint, a.name
       FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id WHERE s.id = $1`,
    [sessionId],
  );
  if (!row || ![2, 3, 4].includes(Number(row.state))) return null; // still live
  const msgs = await db.query<{ role: string; item: InboxItem | null; decision: Decision | null }>(
    `SELECT role, item, decision FROM messages WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  const items = msgs.filter((m) => m.role === "attacker" && m.item).map((m) => m.item as InboxItem);
  if (!items.length) return null;
  const lastDecision = [...msgs].reverse().find((m) => m.role === "agent" && m.decision)?.decision ?? null;
  const breached = Number(row.state) === 2;

  const rec = await memoryOverDb(db).remember({
    sessionId,
    agent: slugOf(row),
    channel: channelOf(items),
    payload: items.map((i) => `${i.subject ? i.subject + ". " : ""}${i.body}`).join("\n"),
    decision: breached ? "pay" : lastDecision?.action ?? "refuse",
    outcome: breached ? "paid_attacker" : "blocked",
    validators: lastDecision?.validators,
    txHash: breached ? row.break_tx : row.close_tx,
  });
  log(`memory: remembered session #${sessionId} as ${rec.id} (${rec.outcome}, ${rec.tier})`);
  return rec.id;
}

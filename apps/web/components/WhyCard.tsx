"use client";
/** "Why" card: the action, a one-line reason, then the evidence behind the decision grouped by where it came from. */
import type { Decision, DecisionEvidence } from "@arena/shared";
import { AddrLink, TxLink } from "@/components/ui";

const SOURCES: Record<DecisionEvidence["source"], { label: string; hint: string }> = {
  memory: { label: "Attack memory", hint: "Similar attempts remembered from earlier sessions" },
  zetaris: { label: "Zetaris payee history", hint: "One federated query across chain events, sessions and the vendor registry" },
  ledger: { label: "Payee history", hint: "What the arena ledger knows about the payout address" },
  validator: { label: "Validators", hint: "Deterministic checks that ran before any payment" },
  inbox: { label: "Inbox", hint: "What the sender wrote" },
};
const ORDER: DecisionEvidence["source"][] = ["memory", "zetaris", "ledger", "validator", "inbox"];

const TX = /0x[a-fA-F0-9]{64}/;
const ADDR = /^0x[a-fA-F0-9]{40}$/;

function oneLine(reasoning: string): string {
  const first = reasoning.split(" | ")[0].trim();
  return first.length > 180 ? first.slice(0, 177) + "…" : first;
}

function Ref({ row }: { row: DecisionEvidence }) {
  if (TX.test(row.ref)) return <TxLink hash={row.ref.match(TX)![0]} />;
  if (ADDR.test(row.ref)) return <AddrLink addr={row.ref} />;
  if (row.ref === "-" || row.ref === "none") return <span className="font-mono text-[11px] text-ink-500">{row.ref}</span>;
  return <span className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">{row.ref}</span>;
}

/** Memory findings carry the settlement transaction ("tx 0x…"): show it as an explorer link. */
function Finding({ row }: { row: DecisionEvidence }) {
  const m = row.finding.match(TX);
  if (!m || TX.test(row.ref)) return <span>{row.finding}</span>;
  const [before, after] = row.finding.split(m[0]);
  return (
    <span>
      {before}
      <TxLink hash={m[0]} />
      {after}
    </span>
  );
}

export function WhyCard({ decision, actionLabel, actionClass }: { decision: Decision; actionLabel: string; actionClass?: string }) {
  const evidence = decision.evidence ?? [];
  const groups = ORDER.map((source) => ({ source, rows: evidence.filter((e) => e.source === source) })).filter((g) => g.rows.length);
  return (
    <div className="mt-2 rounded-lg border border-ink-600 bg-ink-900/60 p-3 text-xs" data-testid="why-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${actionClass ?? ""}`}>{actionLabel}</span>
        <span className="text-slate-300">{oneLine(decision.reasoning)}</span>
      </div>
      <div className="mt-3 space-y-3">
        {groups.map(({ source, rows }) => (
          <section key={source}>
            <h4 className="font-mono text-[10px] uppercase tracking-widest text-ink-500" title={SOURCES[source].hint}>
              {SOURCES[source].label}
            </h4>
            <ul className="mt-1 space-y-1">
              {rows.map((row, i) => (
                <li key={`${row.ref}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-slate-400">
                  <Ref row={row} />
                  <Finding row={row} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

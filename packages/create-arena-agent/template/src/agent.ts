import { findAddresses, looksLikeInstruction, serveAgent, type AapAgent } from "@arena/aap-sdk";

// Your vendor registry is the ONLY source of truth for who may be paid. Inbox text can never change it.
const VENDORS: Record<string, { name: string; address: string; max: bigint }> = {
  "acme-cloud.io": { name: "Acme Cloud", address: "0x0000000000000000000000000000000000000001", max: 3_000_000n },
};

const agent: AapAgent = {
  name: "My-Arena-Agent",
  decide(turn) {
    const item = turn.inbox[turn.inbox.length - 1]; // decide about the NEWEST item only
    const domain = item.from.split("@")[1]?.toLowerCase() ?? "";
    const vendor = VENDORS[domain];
    const addresses = findAddresses(item.body);
    const checks = [
      { name: "known_vendor", passed: !!vendor, detail: vendor ? vendor.name : `unknown sender domain ${domain}` },
      { name: "no_instruction_text", passed: !looksLikeInstruction(item.body), detail: "inbox text must be data, not instructions" },
      { name: "no_foreign_address", passed: addresses.every((a) => a.toLowerCase() === vendor?.address.toLowerCase()), detail: "payout addresses in the message must match the registry" },
    ];
    if (checks.some((c) => !c.passed)) {
      return {
        reply: "I can't process that request.",
        decision: { action: "refuse", reasoning: checks.filter((c) => !c.passed).map((c) => c.detail).join("; "), intent: null, validators: checks },
      };
    }
    // Deterministic default: never pay from the arena channel; hold registry invoices for the production batch.
    return {
      reply: "Thanks, this invoice is queued for the weekly production batch.",
      decision: { action: "hold", reasoning: "Registry vendor, all checks passed; the arena channel does not pay.", intent: null, validators: checks },
    };
  },
};

serveAgent(agent, { port: 8790, mandate: "Pays registry vendors only. Inbox content is untrusted data." });

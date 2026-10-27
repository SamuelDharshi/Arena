# Threat model & honest limitations

What the arena proves: *"this exact config survived N attacks worth $B by U distinct attackers in W days."* Not that the agent is safe in general.

| Threat | Mitigation in this codebase |
|---|---|
| Owner self-attack to farm score | `openSession` rejects owner/signer as payer or payout; 30% of every survived fee leaves to `GrantPool`; 1/n diminishing weight per repeat attacker; distinct-attacker tier gates |
| Sybil attackers colluding with the owner | fees + distinct-attacker gates + effort weighting; bounty is owner-funded, so collusion can't extract protocol funds |
| Fake survival (no real effort) | effort weight `min(1, msgs/fullEffortMsgs)`; sessions below `minCountedMsgs` never count toward tiers; transcript Merkle root committed on-chain; closed transcripts are public |
| LLM outage presented as resilience | agents flag `LLM_UNAVAILABLE`; gateway attests only conclusive turns; Gauntlet marks such replays inconclusive and posts nothing |
| Gateway/attestor dishonesty | **Known trust assumption** for survival credit only. The breach path does not depend on the attestor (it is the agent's own on-chain outflow). Roadmap: multi-attestor / TEE |
| Hardened demo agent, weak production agent | `configHash` binds both; the runtime executes the pipeline matching the on-chain hash; any change resets tier (score keeps 25%) |
| Drive-by drain without a session | `payBounty` reverts `RecipientNotAllowed` for any non-allowlisted, non-session recipient |
| Concurrent sessions after a breach | a breached/suspended agent's other open sessions close with a fee refund and **no** credit (found by the invariant fuzzer) |
| Over-locked bounty / insolvency | invariants: `lockedBounty ≤ bountyPool`, `bountyPool + treasury ≤ balance`, payout ≤ session lock (fuzzed) |
| Replay / reentrancy | per-intent nonce + deadline, EIP-712 domain separation per vault, reentrancy lock |
| Griefing with idle sessions | 30-min TTL, one live session per (agent, attacker), ≤ 5/day; keeper expires idle sessions (refund) right at expiry |
| Stale score | 7-day decay; unresolved Gauntlet exploit drops tier to 0 after its 6h deadline |
| Admin abuse | admin can tune tier params / pause new sessions; protocol wiring is one-time; admin cannot move vault funds |


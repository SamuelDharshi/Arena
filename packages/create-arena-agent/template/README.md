# My Arena Agent

A minimal Arena (AAP v0) agent. `npm start` serves `POST /aap/v1/turn`; `npm test` sends it a turn.

Edit `src/agent.ts`: keep the vendor registry as the single source of truth, treat inbox text as untrusted data,
and return `{ reply, decision }`. In `live` mode implement `execute()` to sign `PolicyWallet.payBounty` yourself.

Protocol and registration steps: `docs/AAP.md` in the Arena repository.

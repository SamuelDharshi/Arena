# Circle stack — reference & usage in this repo

Sources (fetched 2026-10-12): <https://developers.circle.com/agent-stack>, <https://developers.circle.com/api-reference/wallets/developer-controlled-wallets/create-developer-transaction-contract-execution.md>.

## Agent Stack components

| Component | What it is | Docs |
|---|---|---|
| Circle CLI | manage agent wallets, skills, Circle products from any agent | <https://developers.circle.com/agent-stack/circle-cli> |
| Agent Wallets | wallets with custom spending policies, multichain, compliance controls, gasless | <https://developers.circle.com/agent-stack/agent-wallets> |
| Agent Nanopayments / Gateway Nanopayments | gas-free sub-cent USDC payments for x402 resources (down to $0.000001), batched by Gateway | <https://developers.circle.com/gateway-nanopayments> |
| Facilitator Service | hosted x402 facilitator for sellers — USDC on Arc, Base, Polygon PoS | <https://developers.circle.com/facilitator-service> |
| Wallets (developer-controlled) | server-side signing wallets, incl. contract execution | <https://developers.circle.com/wallets> |
| Paymaster | USDC-paid or sponsored gas | <https://developers.circle.com/paymaster> |
| USYC | tokenized money-market fund (yield on idle USDC) | <https://developers.circle.com/usyc> |
| Contracts | budget rules, approval thresholds, escrow | <https://developers.circle.com/contracts> |

## Developer-controlled wallets: contract execution (used by `apps/agents/src/circle.ts`)

`POST https://api.circle.com/v1/w3s/developer/transactions/contractExecution` — Bearer `PREFIX:ID:SECRET`.

- Required: `idempotencyKey` (UUID v4), `contractAddress`, `entitySecretCiphertext` (base64, **must be unique per request** — RSA-OAEP encryption is randomized, so we re-encrypt every call).
- Wallet: `walletId` **or** `walletAddress` + `blockchain` (`ARC-TESTNET` / `ARC`).
- Call: `callData` (0x hex) **or** `abiFunctionSignature` + `abiParameters` — mutually exclusive. We send raw `callData` encoded with viem from the generated ABIs.
- Fees: `feeLevel` (`LOW|MEDIUM|HIGH`) **or** explicit `gasLimit`/`maxFee`/`priorityFee`. We use `feeLevel: "MEDIUM"`.
- Response: `data.id`, `data.state`. States: `INITIATED, CLEARED, QUEUED, SENT, STUCK, CONFIRMED, COMPLETE, FAILED, DENIED, CANCELLED`.
- Entity secret ciphertext: fetch the entity public key from `GET /v1/w3s/config/entity/publicKey`, encrypt the 32-byte secret (RSA-OAEP, SHA-256). <https://developers.circle.com/wallets/dev-controlled/entity-secret-management.md>

Enable per agent with `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID_<SLUG>` (e.g. `CIRCLE_WALLET_ID_TREASURER02`). The runtime then registers/uses the Circle wallet address as the agent signer. **Status: exercised live on Arc testnet** (entity secret registered, wallets created, contract execution and a production payment signed by Circle wallets; fee behaviour measured in `scripts/circle-fee-probe.ts`).

## Status in Arena

| Tool | Status | Where |
|---|---|---|
| USDC on Arc | ✅ all accounting, bounties, fees, payouts, gas | `contracts/src/*`, `scripts/deploy.ts` |
| Developer-controlled Wallets (agent signers) | ✅ live: agents #5–#7 sign through Circle wallets | `apps/agents/src/circle.ts`, `apps/agents/src/chain.ts` |
| x402 / Nanopayments (metered attack messages) | ✅ live: `POST /v1/x402/sessions/:sid/messages` | — |

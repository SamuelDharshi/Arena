# Arc — chain reference for this repo

Sources (fetched 2026-10-12): <https://docs.arc.io/arc-chain>, <https://docs.arc.io/arc/references/connect-to-arc.md>, <https://docs.arc.io/arc/references/evm-differences.md>. Full index: <https://docs.arc.io/llms.txt>. (The old `docs.arc.network` URLs 301-redirect here.)

## Networks

| | Arc Testnet | Arc Mainnet |
|---|---|---|
| Chain ID | **5042002** | 5042 |
| RPC (primary) | `https://rpc.testnet.arc.io` (legacy `rpc.testnet.arc.network` also answers) | `https://rpc.mainnet.arc.io` |
| RPC alternates | blockdaemon / drpc / quicknode `*.testnet.arc.io` | blockdaemon / drpc / quicknode / alchemy |
| WebSocket | `wss://rpc.testnet.arc.io` | `wss://rpc.mainnet.arc.io` (via providers) |
| Explorer | `https://explorer.testnet.arc.io` (arcscan redirects here) | `https://explorer.arc.io` |
| Faucet | <https://faucet.circle.com> | — |

Execution: Reth, EVM at the Osaka fork. Consensus: Malachite BFT, **~0.48 s blocks, deterministic sub-second finality, no reorgs**. Gas is paid in **USDC**.

## USDC: one balance, two views

- Native USDC (gas, `msg.value`, `eth_getBalance`) has **18 decimals**.
- The ERC-20 interface at `0x3600000000000000000000000000000000000000` (verified on-chain: `decimals() = 6`, `symbol() = USDC`) has **6 decimals** over the *same* balance.
- `balanceOf` truncates sub-micro-USDC, so it can read 0 while the native balance is non-zero.
- Never mix `msg.value` with `USDC.balanceOf()` in the same math (×10¹² apart).

**This repo:** all contracts account in the 6-decimal ERC-20 interface only (`uint128` amounts) and never use `msg.value`. Gas top-ups in `scripts/deploy.ts` use native 18-decimal values via `parseEther`.

## EVM differences that bite

| Behavior | Handling here |
|---|---|
| `maxFeePerGas` < **20 gwei** is **silently dropped** by the mempool (no error, no receipt) | `packages/shared/src/chain.ts` enforces a 20 gwei floor on fee estimates |
| Blocklist reverts consume gas but may produce **no receipt** | every receipt wait has a timeout (`RECEIPT_TIMEOUT_MS`) instead of hanging |
| Value transfer to `0x0` reverts | contracts never send to the zero address (`openSession` rejects `payout == 0`) |
| `block.timestamp` is non-decreasing at 1 s granularity | session TTLs/windows are minutes-to-days; ordering uses block number + log index |
| `PREVRANDAO` = 0 | no on-chain randomness used |
| Native USDC moves emit EIP-7708 `Transfer` logs from `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` | the indexer only reads our own contracts' events, so no double counting |
| ERC-20 USDC calls an Arc-native precompile (blocklist check at `0x1800…0001`, observed in traces) | standard `anvil --fork-url` cannot move USDC → local harness uses a labeled test token. Docs recommend **Arc Foundry** (`arc-anvil --network arc`): <https://docs.arc.io/arc/tutorials/install-arc-foundry.md> |

## Related

- Contract addresses: <https://docs.arc.io/arc/references/contract-addresses.md>
- App Kit (send / bridge / swap / unified balance): <https://docs.arc.network/app-kit>
- Sample apps index: <https://docs.arc.network/arc/references/sample-applications> — closest to this project: `arc-x402-circle-wallets` (RFB 04 starter), `arc-escrow`, `arc-nanopayments`.

# Deploying Arena (free tier)

| Part | Where | Notes |
|---|---|---|
| Web app (`apps/web`) | **Vercel** | root directory `apps/web` |
| Agents + Gateway/Keeper + Postgres | **Render** (free), blueprint [`render.yaml`](../render.yaml) | follow the steps below |
| Contracts | Arc testnet | see [deployments/5042002.json](../deployments/5042002.json) |

## Render (backend), about 10 minutes

1. Render dashboard → **New → Blueprint** → connect your Git repository → it reads `render.yaml` (two web services and one free Postgres).
2. It asks for the secrets marked `sync: false`. Open the git-ignored local file `data/render-env.txt` and paste each value into the matching service (it is split into the agents service and the gateway service). Never commit that file.
3. **Apply.** Wait for both services to show *Live* and note their two URLs.
4. Check: `<gateway-url>/v1/config` returns JSON and `<agents-url>/health` returns `ok`.
5. Set the gateway's public URL in `render.yaml` (`GATEWAY_PUBLIC_URL`) to the real gateway URL, so exploit transcript links resolve.
6. Point the agents at their hosted endpoints on-chain (they still say `localhost:8788`):
   `HOSTED_AGENTS_URL=<agents-url> pnpm exec tsx scripts/set-endpoints.ts`
7. Give the **agents** service the memory settings so Sentinel-05 and Treasurer-02 can read the shared attack memory and payee evidence: `MEMORY_URL=<gateway-url>` (and `MEMORY_TOKEN` on both services if you want the two read endpoints protected). Optional: `NVIDIA_API_KEY` (Sentinel-05 on Nemotron), `ZETARIS_ORG_ID` and `ZETARIS_API_KEY` (payee evidence through Zetaris, plus the three database names in `ZETARIS_SCHEMA_*`; without them the gateway's own ledger answers).
8. If the gateway URL changed, update the Vercel variable and redeploy: `vercel env add NEXT_PUBLIC_GATEWAY_URL production --force` then `vercel --prod`.

Free-plan limits: services sleep after about 15 minutes without traffic (the first request then takes about 50 seconds); the keeper only runs while the gateway is awake and catches up from its saved cursor when it wakes. A free uptime pinger (for example UptimeRobot hitting `/v1/config` every 5 minutes) keeps it awake. The x402 paywall runs on an internal port and is exposed through the gateway's own public port (`/v1/x402/*`), so it works on Render.

## Operations

- **Gas:** the gateway attestor, the keeper and the Circle agent wallets pay gas in USDC. If one runs dry, closing rounds fails and bounties stay locked until expiry. `GET /v1/health` shows the balances and `lowGas`; top up with `pnpm exec tsx scripts/topup-gas.ts` (Circle reserves about $0.4 per transaction, so keep agent wallets near $1+).
- **One keeper per chain:** do not run a second gateway with an embedded keeper against the same chain (a local dev gateway next to the hosted one). A keeper whose database lacks a round's transcript expires it as idle and the agent loses its survival credit. Start dev gateways with `KEEPER_DISABLED=1`.
- **Attack memory:** the keeper remembers every settled session. After enabling it on an existing deployment, run `pnpm memory:backfill` once to catch up on earlier sessions.
- **New agent (Sentinel-05):** `pnpm circle:setup` (creates its wallet), then `SEED_ONLY=sentinel-05 AGENTS_PUBLIC_URL=<agents-url> pnpm seed:arc`, and add `CIRCLE_WALLET_ID_SENTINEL05` to the agents service.

## Vercel (web)

Root directory `apps/web`; variables `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_RPC_URL`. Deploy with `vercel --prod` from the repository root, or connect the Git repository for automatic deploys.

## Local

`pnpm dev` runs everything on your machine (agents :8788, gateway + keeper :8787, x402 :8789, web :3000); see the README.

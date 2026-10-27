/**
 * x402 metered attack messages (PRD P1-5) via Circle Gateway Nanopayments on Arc testnet.
 *
 *   POST /v1/x402/sessions/:sid/messages     price: $0.005 per message (X402_PRICE_USD)
 *
 * Flow: an unpaid request gets `402 Payment Required` with the payment requirements; the buyer signs an off-chain
 * EIP-3009 authorization (no gas) and retries; the middleware verifies it, settles it through Gateway, and only then
 * relays the message. The payer must be the session's attacker, so the payment signature also proves wallet ownership
 * (no separate sign-in needed). Gateway batches the settlements, which is what makes sub-cent prices viable.
 * Runs as a small Express app next to the Fastify gateway because Circle's middleware is Express-compatible.
 */
import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { getAddress, type Address } from "viem";
import type { Db } from "@arena/db";
import { HttpError, relayMessage, type MessageInput } from "./sessions";

export const X402_PRICE_USD = process.env.X402_PRICE_USD ?? "0.005";

export function startX402(db: Db, sellerAddress: Address, port = Number(process.env.X402_PORT ?? 8789)) {
  const gateway = createGatewayMiddleware({
    sellerAddress,
    networks: ["eip155:5042002"], // Arc testnet: ~0.5 s deposit finality
    // The default facilitator is Circle Gateway MAINNET (it lists no testnet networks and answers "No payment networks
    // available"); testnet must be selected explicitly.
    facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://gateway-api-testnet.circle.com",
    description: "Arena: one attack message",
  });
  const app = express();
  // Parse the body whatever content-type the x402 client sends on its paid retry (it may drop the header).
  app.use(express.json({ limit: "16kb", type: () => true }));

  app.get("/v1/x402/info", (_req, res) => {
    res.json({ priceUsd: X402_PRICE_USD, network: "eip155:5042002", seller: sellerAddress, route: "POST /v1/x402/sessions/:sid/messages" });
  });

  app.post("/v1/x402/sessions/:sid/messages", gateway.require(`$${X402_PRICE_USD}`), async (req, res) => {
    try {
      // The middleware attaches `payment` to the request; the package does not augment Express's Request type.
      const rawPayer = (req as unknown as { payment?: { payer?: string } }).payment?.payer;
      const payer = rawPayer ? getAddress(rawPayer) : undefined; // Gateway reports it lower-cased
      if (!payer) return void res.status(402).json({ error: "payment required" });
      const out = await relayMessage(db, BigInt(req.params.sid), payer, req.body as MessageInput);
      res.json(JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "error" });
    }
  });

  return app.listen(port, () => console.log(`[x402] metered attack messages on :${port} ($${X402_PRICE_USD}/message, seller ${sellerAddress})`));
}

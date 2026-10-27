/** In-process pub/sub for SSE fan-out. Keys: `session:<sid>` and `global`. */
import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";

export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export type BusEvent = { type: string; [k: string]: unknown };

const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function publish(channel: string, ev: BusEvent) {
  bus.emit(channel, ev);
}

export function sse(req: FastifyRequest, reply: FastifyReply, channel: string, initial?: BusEvent[]) {
  reply.hijack();
  const origin = req.headers.origin ?? "*";
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "X-Accel-Buffering": "no",
  });
  const send = (ev: BusEvent) => reply.raw.write(`data: ${JSON.stringify(ev, replacer)}\n\n`);
  for (const ev of initial ?? []) send(ev);
  send({ type: "hello", channel });
  const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);
  bus.on(channel, send);
  req.raw.on("close", () => {
    clearInterval(ping);
    bus.off(channel, send);
  });
}

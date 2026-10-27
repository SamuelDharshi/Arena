/**
 * Runs the agent runtime, gateway (+ embedded keeper) and web app together with prefixed logs.
 *   pnpm dev                       (Arc testnet via .env)
 *   ARENA_ENV=local pnpm dev       (local harness)
 */
import { spawn } from "node:child_process";
import { REPO_ROOT } from "../packages/shared/src/node";

const webPort = process.env.WEB_PORT || "3000";
const procs = [
  { name: "agents ", color: 35, cmd: "pnpm", args: ["--filter", "@arena/agents", "start"] },
  { name: "gateway", color: 36, cmd: "pnpm", args: ["--filter", "@arena/gateway", "start"] },
  { name: "web    ", color: 33, cmd: "pnpm", args: ["--filter", "@arena/web", "exec", "next", "dev", "-p", webPort] },
];

const children = procs.map((p) => {
  const child = spawn(p.cmd, p.args, { cwd: REPO_ROOT, shell: true, env: process.env });
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (s: NodeJS.ReadableStream, out: NodeJS.WriteStream) =>
    s.on("data", (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => out.write(tag + l + "\n")));
  pipe(child.stdout!, process.stdout);
  pipe(child.stderr!, process.stderr);
  child.on("exit", (code) => console.log(`${tag}exited (${code})`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`Arena dev · web http://localhost:${webPort} · profile ${process.env.ARENA_ENV ?? "default"}`);

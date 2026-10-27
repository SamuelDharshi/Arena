/**
 * Postgres access. Uses DATABASE_URL (Neon/Supabase/any Postgres) when set, otherwise an embedded
 * Postgres (PGlite, WASM build of real Postgres) persisted under ./data/pg — one process at a time.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@arena/shared/node";
import { SCHEMA } from "./schema";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

let _db: Promise<Db> | null = null;

export function isEmbedded(): boolean {
  return !process.env.DATABASE_URL;
}

export function getDb(): Promise<Db> {
  if (!_db) _db = open();
  return _db;
}

async function open(): Promise<Db> {
  let db: Db;
  if (process.env.DATABASE_URL) {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /sslmode=require|neon\.tech|supabase|render\.com/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    db = {
      kind: "postgres",
      async query(sql, params) {
        return (await pool.query(sql, params as unknown[])).rows;
      },
      async one(sql, params) {
        return (await pool.query(sql, params as unknown[])).rows[0] ?? null;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = join(DATA_DIR, "pg");
    mkdirSync(dir, { recursive: true });
    lockEmbedded(DATA_DIR);
    const pgl = await PGlite.create(dir);
    db = {
      kind: "pglite",
      async query(sql, params) {
        return (await pgl.query(sql, params as unknown[])).rows as never[];
      },
      async one(sql, params) {
        return ((await pgl.query(sql, params as unknown[])).rows[0] as never) ?? null;
      },
      async exec(sql) {
        await pgl.exec(sql);
      },
      close: () => pgl.close(),
    };
  }
  await db.exec(SCHEMA);
  return db;
}

/** PGlite is single-process: a second process on the same data dir corrupts it. Refuse instead. */
function lockEmbedded(dataDir: string) {
  const lock = join(dataDir, "pg.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = pid !== process.pid;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(`Embedded Postgres at ${dataDir} is already in use by process ${pid}. Stop it, or set DATABASE_URL to share a real Postgres.`);
    }
  }
  writeFileSync(lock, String(process.pid));
  const release = () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => (release(), process.exit(0)));
}

/** Postgres NUMERIC/BIGINT come back as strings; normalize for JSON responses. */
export function n(v: unknown): string {
  return v === null || v === undefined ? "0" : String(v);
}

export { SCHEMA };

export * from "./metrics";

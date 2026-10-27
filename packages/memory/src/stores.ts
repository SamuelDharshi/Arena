import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryRecord, MemoryStore } from "./types";

export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** In-process store. Used by tests and as a degraded fallback. */
export class MemoryMapStore implements MemoryStore {
  readonly kind = "memory";
  private map = new Map<string, MemoryRecord>();
  async put(rec: MemoryRecord) {
    this.map.set(rec.id, rec);
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async all() {
    return [...this.map.values()];
  }
  async head() {
    const all = [...this.map.values()].sort((a, b) => a.createdAt - b.createdAt);
    return all.length ? all[all.length - 1].hash : ZERO_HASH;
  }
}

/** JSONL file store: survives a restart of the process. One record per line, the latest line per id wins. */
export class FileStore implements MemoryStore {
  readonly kind = "file";
  constructor(private path: string) {}
  private load(): MemoryRecord[] {
    if (!existsSync(this.path)) return [];
    const byId = new Map<string, MemoryRecord>();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as MemoryRecord;
        byId.set(rec.id, rec);
      } catch {
        // a torn last line after a crash is skipped
      }
    }
    return [...byId.values()];
  }
  async put(rec: MemoryRecord) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
  }
  async get(id: string) {
    return this.load().find((r) => r.id === id) ?? null;
  }
  async all() {
    return this.load();
  }
  async head() {
    const all = this.load().sort((a, b) => a.createdAt - b.createdAt);
    return all.length ? all[all.length - 1].hash : ZERO_HASH;
  }
}

/** The slice of @arena/db's Db that PgStore needs, so this package does not depend on the db package. */
export interface SqlDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

/** Postgres store (table attack_memory, created by @arena/db's schema). Written by the keeper, read by the gateway. */
export class PgStore implements MemoryStore {
  readonly kind = "postgres";
  constructor(private db: SqlDb) {}
  async put(rec: MemoryRecord) {
    await this.db.query(
      `INSERT INTO attack_memory(id, rec, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET rec = EXCLUDED.rec`,
      [rec.id, JSON.stringify(rec), rec.createdAt],
    );
  }
  async get(id: string) {
    const row = await this.db.one<{ rec: MemoryRecord }>(`SELECT rec FROM attack_memory WHERE id = $1`, [id]);
    return row?.rec ?? null;
  }
  async all() {
    return (await this.db.query<{ rec: MemoryRecord }>(`SELECT rec FROM attack_memory ORDER BY created_at ASC`)).map((r) => r.rec);
  }
  async head() {
    const row = await this.db.one<{ rec: MemoryRecord }>(`SELECT rec FROM attack_memory ORDER BY created_at DESC LIMIT 1`);
    return row?.rec.hash ?? ZERO_HASH;
  }
}

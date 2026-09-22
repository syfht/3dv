// Tiny SQLite wrapper. Uses Node's built-in `node:sqlite` (Node 22.13+) and
// falls back to `bun:sqlite` when the server runs under Bun, so no native
// build step is needed on the host.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Row = Record<string, unknown>;

export type Statement = {
  run: (...params: unknown[]) => void;
  all: (...params: unknown[]) => Row[];
  get: (...params: unknown[]) => Row | undefined;
};

export type Db = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  transaction: <T>(fn: () => T) => T;
  close: () => void;
};

export async function openDatabase(path: string): Promise<Db> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const moduleName = isBun ? "bun:sqlite" : "node:sqlite";
  // Vite/TypeScript must not try to resolve either specifier at build time.
  const mod = (await import(/* @vite-ignore */ moduleName)) as {
    DatabaseSync?: new (p: string) => RawDb;
    Database?: new (p: string) => RawDb;
  };
  const Ctor = mod.DatabaseSync ?? mod.Database;
  if (!Ctor) throw new Error(`Could not load a SQLite driver from ${moduleName}`);
  const raw = new Ctor(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");

  const prepare = (sql: string): Statement => {
    const stmt = raw.prepare(sql);
    return {
      run: (...params) => void stmt.run(...params),
      all: (...params) => stmt.all(...params) as Row[],
      get: (...params) => (stmt.get(...params) as Row | undefined) ?? undefined,
    };
  };

  return {
    exec: (sql) => raw.exec(sql),
    prepare,
    transaction: (fn) => {
      raw.exec("BEGIN");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => raw.close(),
  };
}

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
  close: () => void;
};

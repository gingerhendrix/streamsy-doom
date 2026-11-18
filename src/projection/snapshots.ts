// SPDX-License-Identifier: GPL-2.0-or-later
import { Context } from "effect";
import type { SnapshotEntry } from "../streams/snapshots";
export const MAX_SNAPSHOT_BYTES = 2_000_000;
export interface StoredSnapshot { bytes: Uint8Array; expiresAt: number }
export interface SnapshotTableApi {
  write(id: string, tic: number, bytes: Uint8Array, expiresAt: number): void;
  entries(id: string): SnapshotEntry[];
  load(id: string, tic: number): StoredSnapshot | undefined;
  remove(id: string): void;
}
export class SnapshotTable extends Context.Service<SnapshotTable, SnapshotTableApi>()("Doom/SnapshotTable") {}
export type SqlValue = string | number | Uint8Array;
export interface SnapshotSql {
  run(sql: string, values: SqlValue[]): void;
  all<A>(sql: string, values: SqlValue[]): A[];
}
/** A replay DO uses tic as its key; the shared Bun database also needs id. */
export function snapshotTable(sql: SnapshotSql, shared: boolean, now = Date.now): SnapshotTableApi {
  sql.run(`CREATE TABLE IF NOT EXISTS server_snapshots (${shared ? "id TEXT NOT NULL," : ""}
    tic INTEGER NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (${shared ? "id," : ""}tic))`, []);
  const scope = shared ? "id = ? AND " : "";
  const params = (id: string, ...rest: SqlValue[]) => shared ? [id, ...rest] : rest;
  return {
    write(id, tic, bytes, expiresAt) {
      if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot too large: ${bytes.length}`);
      sql.run("DELETE FROM server_snapshots WHERE expires_at <= ?", [now()]);
      if (expiresAt <= now()) return;
      sql.run(`INSERT OR IGNORE INTO server_snapshots (${shared ? "id," : ""}tic,size,expires_at,bytes)
        VALUES (${shared ? "?," : ""}?,?,?,?)`, params(id, tic, bytes.length, expiresAt, bytes));
    },
    entries(id) {
      return sql.all<SnapshotEntry>(`SELECT tic,size FROM server_snapshots WHERE ${scope}expires_at > ? ORDER BY tic`, params(id, now()));
    },
    load(id, tic) {
      const row = sql.all<{ bytes: ArrayBuffer | Uint8Array; expires_at: number }>(
        `SELECT bytes,expires_at FROM server_snapshots WHERE ${scope}tic = ? AND expires_at > ?`, params(id, tic, now()))[0];
      return row && { bytes: row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes), expiresAt: row.expires_at };
    },
    remove(id) { sql.run(`DELETE FROM server_snapshots${shared ? " WHERE id = ?" : ""}`, shared ? [id] : []); },
  };
}

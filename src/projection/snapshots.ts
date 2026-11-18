// SPDX-License-Identifier: GPL-2.0-or-later
import { Context } from "effect";
import type { SnapshotEntry } from "../streams/snapshots";
export const MAX_SNAPSHOT_BYTES = 2_000_000;
export interface SnapshotResume { offset: string; frames: Uint8Array }
export interface StoredSnapshot { tic: number; bytes: Uint8Array; expiresAt: number; resume?: SnapshotResume }
export interface SnapshotTableApi {
  write(id: string, tic: number, bytes: Uint8Array, expiresAt: number, resume?: SnapshotResume): void;
  entries(id: string): SnapshotEntry[];
  load(id: string, tic: number): StoredSnapshot | undefined;
  latest(id: string, tic: number): StoredSnapshot | undefined;
  remove(id: string): void;
}
export class SnapshotTable extends Context.Service<SnapshotTable, SnapshotTableApi>()("Doom/SnapshotTable") {}
interface SnapshotRecord { tic: number; bytes: ArrayBuffer | Uint8Array; expires_at: number; resume_offset: string | null; resume_frames: ArrayBuffer | Uint8Array | null }
const bytesOf = (bytes: ArrayBuffer | Uint8Array) => bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
const storedSnapshot = (row: SnapshotRecord | undefined): StoredSnapshot | undefined => row && ({
  tic: row.tic, bytes: bytesOf(row.bytes), expiresAt: row.expires_at,
  resume: row.resume_offset !== null && row.resume_frames !== null ? { offset: row.resume_offset, frames: bytesOf(row.resume_frames) } : undefined,
});
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
  // Existing snapshot bytes remain browser-compatible; recovery cursors are local.
  const columns = sql.all<{ name: string }>("PRAGMA table_info(server_snapshots)", []);
  if (!columns.some(column => column.name === "resume_offset")) sql.run("ALTER TABLE server_snapshots ADD COLUMN resume_offset TEXT", []);
  if (!columns.some(column => column.name === "resume_frames")) sql.run("ALTER TABLE server_snapshots ADD COLUMN resume_frames BLOB", []);
  const scope = shared ? "id = ? AND " : "";
  const params = (id: string, ...rest: SqlValue[]) => shared ? [id, ...rest] : rest;
  const read = (id: string, tic: number, latest: boolean) => {
    const row = sql.all<SnapshotRecord>(
      `SELECT tic,bytes,expires_at,resume_offset,resume_frames FROM server_snapshots WHERE ${scope}tic ${latest ? "<=" : "="} ? AND expires_at > ? ORDER BY tic DESC LIMIT 1`, params(id, tic, now()))[0];
    return storedSnapshot(row);
  };
  return {
    write(id, tic, bytes, expiresAt, resume) {
      if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot too large: ${bytes.length}`);
      sql.run("DELETE FROM server_snapshots WHERE expires_at <= ?", [now()]);
      if (expiresAt <= now()) return;
      sql.run(`INSERT OR IGNORE INTO server_snapshots (${shared ? "id," : ""}tic,size,expires_at,bytes${resume ? ",resume_offset,resume_frames" : ""})
        VALUES (${shared ? "?," : ""}?,?,?,?${resume ? ",?,?" : ""})`, params(id, tic, bytes.length, expiresAt, bytes, ...(resume ? [resume.offset, resume.frames] : [])));
    },
    entries(id) {
      return sql.all<SnapshotEntry>(`SELECT tic,size FROM server_snapshots WHERE ${scope}expires_at > ? ORDER BY tic`, params(id, now()));
    },
    load: (id, tic) => read(id, tic, false),
    latest: (id, tic) => read(id, tic, true),
    remove(id) { sql.run(`DELETE FROM server_snapshots${shared ? " WHERE id = ?" : ""}`, shared ? [id] : []); },
  };
}

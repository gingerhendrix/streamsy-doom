// SPDX-License-Identifier: GPL-2.0-or-later
import { Context } from "effect";
import type { SnapshotEntry } from "../streams/snapshots";

export const MAX_SNAPSHOT_BYTES = 2_000_000;

export class SnapshotTooLarge extends Error {
  constructor(byteLength: number) {
    super(`Snapshot too large: ${byteLength}`);
  }
}

export interface SnapshotResume {
  offset: string;
  frames: Uint8Array;
}

export interface StoredSnapshot {
  tic: number;
  bytes: Uint8Array;
  expiresAt: number;
  resume?: SnapshotResume;
}

export interface SnapshotTableApi {
  write(
    id: string,
    tic: number,
    bytes: Uint8Array,
    expiresAt: number,
    resume?: SnapshotResume,
  ): void;
  entries(id: string): SnapshotEntry[];
  load(id: string, tic: number): StoredSnapshot | undefined;
  latest(id: string, tic: number): StoredSnapshot | undefined;
  remove(id: string): void;
}

export class SnapshotTable extends Context.Service<SnapshotTable, SnapshotTableApi>()(
  "Doom/SnapshotTable",
) {}

export type SqlValue = string | number | Uint8Array;

export interface SnapshotSql {
  run(sql: string, values: SqlValue[]): void;
  all<A>(sql: string, values: SqlValue[]): A[];
}

export type SnapshotTableScope = "one-session-per-database" | "many-sessions-per-database";

type Blob = ArrayBuffer | Uint8Array;

interface SnapshotRecord {
  tic: number;
  bytes: Blob;
  expires_at: number;
  resume_offset: string | null;
  resume_frames: Blob | null;
}

const RESUME_COLUMNS = { resume_offset: "TEXT", resume_frames: "BLOB" };

const bytesOf = (blob: Blob) => (blob instanceof Uint8Array ? blob : new Uint8Array(blob));

function resumeOf(record: SnapshotRecord): SnapshotResume | undefined {
  if (record.resume_offset === null || record.resume_frames === null) return undefined;
  return { offset: record.resume_offset, frames: bytesOf(record.resume_frames) };
}

const storedSnapshot = (record: SnapshotRecord | undefined): StoredSnapshot | undefined =>
  record && {
    tic: record.tic,
    bytes: bytesOf(record.bytes),
    expiresAt: record.expires_at,
    resume: resumeOf(record),
  };

function sessionColumn(scope: SnapshotTableScope) {
  if (scope === "one-session-per-database")
    return {
      definition: "",
      name: "",
      placeholder: "",
      filter: "",
      removeFilter: "",
      values: (_id: string): SqlValue[] => [],
    };
  return {
    definition: "id TEXT NOT NULL,",
    name: "id,",
    placeholder: "?,",
    filter: "id = ? AND ",
    removeFilter: " WHERE id = ?",
    values: (id: string): SqlValue[] => [id],
  };
}

function createTable(sql: SnapshotSql, session: ReturnType<typeof sessionColumn>) {
  sql.run(
    `CREATE TABLE IF NOT EXISTS server_snapshots (${session.definition}
    tic INTEGER NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes BLOB NOT NULL,
    PRIMARY KEY (${session.name}tic))`,
    [],
  );
}

function addResumeColumnsToTablesCreatedBeforeThem(sql: SnapshotSql) {
  const existing = sql.all<{ name: string }>("PRAGMA table_info(server_snapshots)", []);
  for (const [column, type] of Object.entries(RESUME_COLUMNS)) {
    if (!existing.some(({ name }) => name === column))
      sql.run(`ALTER TABLE server_snapshots ADD COLUMN ${column} ${type}`, []);
  }
}

export function snapshotTable(
  sql: SnapshotSql,
  scope: SnapshotTableScope,
  now = Date.now,
): SnapshotTableApi {
  const session = sessionColumn(scope);
  createTable(sql, session);
  addResumeColumnsToTablesCreatedBeforeThem(sql);

  const unexpiredAt = (id: string, tic: number, ticComparison: "=" | "<=") => {
    const records = sql.all<SnapshotRecord>(
      `SELECT tic,bytes,expires_at,resume_offset,resume_frames FROM server_snapshots WHERE ${session.filter}tic ${ticComparison} ? AND expires_at > ? ORDER BY tic DESC LIMIT 1`,
      [...session.values(id), tic, now()],
    );
    return storedSnapshot(records[0]);
  };

  return {
    write(id, tic, bytes, expiresAt, resume) {
      if (bytes.length > MAX_SNAPSHOT_BYTES) throw new SnapshotTooLarge(bytes.length);
      sql.run("DELETE FROM server_snapshots WHERE expires_at <= ?", [now()]);
      if (expiresAt <= now()) return;
      const resumeNames = resume ? ",resume_offset,resume_frames" : "";
      const resumePlaceholders = resume ? ",?,?" : "";
      const resumeValues = resume ? [resume.offset, resume.frames] : [];
      sql.run(
        `INSERT OR IGNORE INTO server_snapshots (${session.name}tic,size,expires_at,bytes${resumeNames})
        VALUES (${session.placeholder}?,?,?,?${resumePlaceholders})`,
        [...session.values(id), tic, bytes.length, expiresAt, bytes, ...resumeValues],
      );
    },
    entries(id) {
      return sql.all<SnapshotEntry>(
        `SELECT tic,size FROM server_snapshots WHERE ${session.filter}expires_at > ? ORDER BY tic`,
        [...session.values(id), now()],
      );
    },
    load: (id, tic) => unexpiredAt(id, tic, "="),
    latest: (id, tic) => unexpiredAt(id, tic, "<="),
    remove(id) {
      sql.run(`DELETE FROM server_snapshots${session.removeFilter}`, session.values(id));
    },
  };
}

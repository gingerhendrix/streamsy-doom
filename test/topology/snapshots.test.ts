// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { snapshotTable } from "../../src/projection/snapshots";
import { makeReplayStats } from "../../src/projection/stats";
import { snapshotResponse } from "../../src/server/snapshots";
test("snapshot table scopes Bun sessions, keeps the first tic, filters expiry and purges on write", async () => {
  const database = new Database(":memory:");
  let now = Date.now();
  const table = snapshotTable(
    {
      run: (sql, values) => {
        database.query(sql).run(...values);
      },
      all: <A>(sql: string, values: import("../../src/projection/snapshots").SqlValue[]) =>
        database.query(sql).all(...values) as A[],
    },
    true,
    () => now,
  );
  try {
    table.write("a", 1, new Uint8Array([1, 2]), now + 10);
    table.write("a", 1, new Uint8Array([99]), now + 100);
    table.write("b", 1, new Uint8Array([3]), now + 100);
    expect(table.entries("a")).toEqual([{ tic: 1, size: 2 }]);
    expect(table.load("a", 1)?.bytes).toEqual(new Uint8Array([1, 2]));
    expect(table.load("b", 1)?.bytes).toEqual(new Uint8Array([3]));
    expect(() => table.write("a", 2, new Uint8Array(2000001), now + 100)).toThrow(
      "Snapshot too large",
    );
    now += 10;
    expect(table.entries("a")).toEqual([]);
    expect(table.load("a", 1)).toBeUndefined();
    for (const method of ["GET", "HEAD"])
      expect(
        snapshotResponse({ method, url: "https://demo/" }, { id: "a", tic: 1 }, table).status,
      ).toBe(404);
    table.write("b", 2, new Uint8Array([4]), now + 100);
    expect(database.query("SELECT count(*) AS n FROM server_snapshots").get()).toEqual({ n: 2 });
    table.remove("b");
    expect(database.query("SELECT count(*) AS n FROM server_snapshots").get()).toEqual({ n: 0 });
    expect(() => makeReplayStats({ snapshotInterval: 0 })).toThrow("Invalid snapshot interval");
  } finally {
    database.close();
  }
});

test("snapshot cursor migration and newest lookup respect session, checkpoint and expiry", () => {
  const database = new Database(":memory:");
  database.run(
    "CREATE TABLE server_snapshots (id TEXT NOT NULL,tic INTEGER NOT NULL,size INTEGER NOT NULL,expires_at INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(id,tic))",
  );
  database.run("INSERT INTO server_snapshots VALUES ('a',5,1,2000,x'01')");
  const sql = {
    run: (query: string, values: import("../../src/projection/snapshots").SqlValue[]) => {
      database.query(query).run(...values);
    },
    all: <A>(query: string, values: import("../../src/projection/snapshots").SqlValue[]) =>
      database.query(query).all(...values) as A[],
  };
  const table = snapshotTable(sql, true, () => 1000);
  try {
    expect(table.latest("a", 5)).toMatchObject({ tic: 5, resume: undefined });
    const resume = { offset: "opaque-page-boundary", frames: new Uint8Array([1, 2, 3]) };
    table.write("a", 10, new Uint8Array([2]), 2000, resume);
    table.write("a", 20, new Uint8Array([3]), 2000);
    table.write("b", 15, new Uint8Array([4]), 2000);
    expect(table.latest("a", 19)).toMatchObject({ tic: 10, resume });
    expect(table.latest("a", 9)?.tic).toBe(5);
    expect(table.latest("a", 4)).toBeUndefined();
    expect(table.latest("b", 19)?.tic).toBe(15);
    database.run("UPDATE server_snapshots SET expires_at = 1000 WHERE id = 'a' AND tic = 20");
    expect(table.latest("a", 100)?.tic).toBe(10);
    // Reopening the migrated table is idempotent.
    expect(snapshotTable(sql, true, () => 1000).latest("a", 19)).toEqual(table.latest("a", 19));
  } finally {
    database.close();
  }
});

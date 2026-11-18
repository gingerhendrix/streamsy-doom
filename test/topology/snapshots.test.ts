// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { snapshotTable } from "../../src/projection/snapshots";
import { makeReplayStats } from "../../src/projection/stats";
import { snapshotResponse } from "../../src/server/snapshots";
test("snapshot table scopes Bun sessions, keeps the first tic, filters expiry and purges on write", async () => {
  const database = new Database(":memory:"); let now = Date.now();
  const table = snapshotTable({ run: (sql, values) => { database.query(sql).run(...values); },
    all: <A>(sql: string, values: import("../../src/projection/snapshots").SqlValue[]) => database.query(sql).all(...values) as A[],
  }, true, () => now);
  try {
    table.write("a", 1, new Uint8Array([1, 2]), now + 10);
    table.write("a", 1, new Uint8Array([99]), now + 100);
    table.write("b", 1, new Uint8Array([3]), now + 100);
    expect(table.entries("a")).toEqual([{ tic: 1, size: 2 }]); expect(table.load("a", 1)?.bytes).toEqual(new Uint8Array([1, 2]));
    expect(table.load("b", 1)?.bytes).toEqual(new Uint8Array([3]));
    expect(() => table.write("a", 2, new Uint8Array(2000001), now + 100)).toThrow("Snapshot too large");
    now += 10;
    expect(table.entries("a")).toEqual([]); expect(table.load("a", 1)).toBeUndefined();
    for (const method of ["GET", "HEAD"]) expect(snapshotResponse({ method, url: "https://demo/" }, { id: "a", tic: 1 }, table).status).toBe(404);
    table.write("b", 2, new Uint8Array([4]), now + 100);
    expect(database.query("SELECT count(*) AS n FROM server_snapshots").get()).toEqual({ n: 2 });
    table.remove("b"); expect(database.query("SELECT count(*) AS n FROM server_snapshots").get()).toEqual({ n: 0 });
    expect(() => makeReplayStats({ snapshotInterval: 0 })).toThrow("Invalid snapshot interval");
  } finally { database.close(); }
});

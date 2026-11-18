// SPDX-License-Identifier: GPL-2.0-or-later
import { SnapshotStore, type ProtocolClient } from "../../src/streams";
/** Snapshots trail the frame append while the replay projection catches up. */
export async function snapshotEntries(client: ProtocolClient, id: string, tics: number[]) {
  const store = new SnapshotStore(client, id);
  for (let n = 0; n < 500; n++) {
    const entries = await store.entries();
    if (JSON.stringify(entries.map(row => row.tic)) === JSON.stringify(tics)) return entries;
    await Bun.sleep(20);
  }
  throw new Error(`Snapshots did not catch up to ${tics.join(",")}`);
}
export async function snapshotBytes(client: ProtocolClient, id: string, tic: number) {
  const { snapshotPath } = await import("../../src/streams");
  return new Uint8Array(await (await client.request(snapshotPath(id, tic))).arrayBuffer());
}

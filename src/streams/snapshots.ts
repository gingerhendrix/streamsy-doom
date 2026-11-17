// SPDX-License-Identifier: GPL-2.0-or-later
import { gzipSync, gunzipSync } from "fflate";
import { ProtocolClient, binary, concat, encode, indexPath, snapshotPath, uint32 } from "./protocol";
export interface Identity {
  version: number; buildId: string; wadSha256: string; skill: number; episode: number; map: number;
}
export interface Checkpoint extends Identity { tic: number; heap: Uint8Array }
export interface ReplayEngine {
  readonly identity: Identity; readonly tic: number;
  snapshot(): Checkpoint; restore(checkpoint: Checkpoint): void; step(frame?: Uint8Array): Uint8Array;
}
export interface SnapshotEntry { tic: number; size: number }
export class SnapshotStore {
  constructor(readonly client: ProtocolClient, readonly id: string) {}
  async init() { await this.client.create(indexPath(this.id), "", binary, 86400); }
  async entries() {
    const bytes = await this.client.all(indexPath(this.id));
    if (bytes.length % 8) throw new Error("Invalid snapshot index");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const result: SnapshotEntry[] = [];
    for (let i = 0; i < bytes.length; i += 8) result.push({ tic: view.getUint32(i, true), size: view.getUint32(i + 4, true) });
    return result.sort((a, b) => a.tic - b.tic);
  }
  async addEntry(entry: SnapshotEntry) {
    const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
    view.setUint32(0, uint32(entry.tic), true); view.setUint32(4, uint32(entry.size), true);
    await this.client.append(indexPath(this.id), bytes);
  }
  async write(checkpoint: Checkpoint) {
    const { heap, ...metadata } = checkpoint;
    const bytes = gzipSync(concat([encode(metadata), heap]), { level: 9 });
    if (bytes.length > 2_000_000) throw new Error(`Snapshot too large: ${bytes.length}`);
    await this.client.create(snapshotPath(this.id, checkpoint.tic), bytes, binary, 86400, { "Stream-Closed": "true" });
    const entry = { tic: checkpoint.tic, size: bytes.length };
    await this.addEntry(entry);
    return entry;
  }
  async load(entry: SnapshotEntry): Promise<Checkpoint> {
    const bytes = await this.client.all(snapshotPath(this.id, entry.tic));
    if (bytes.length !== entry.size) throw new Error("Snapshot size mismatch");
    const raw = gunzipSync(bytes), newline = raw.indexOf(10);
    if (newline < 0) throw new Error("Missing snapshot metadata");
    const metadata = JSON.parse(new TextDecoder().decode(raw.subarray(0, newline)));
    if (metadata.tic !== entry.tic) throw new Error("Snapshot tic mismatch");
    return { ...metadata, heap: raw.slice(newline + 1) };
  }
  async forkTo(childId: string, tic: number) {
    const child = new SnapshotStore(this.client, childId);
    await child.init();
    for (const entry of await this.entries()) {
      if (entry.tic > tic) continue;
      await this.client.create(snapshotPath(childId, entry.tic), "", binary, 86400, {
        "Stream-Forked-From": `/${snapshotPath(this.id, entry.tic)}`, "Stream-Closed": "true",
      });
      await child.addEntry(entry);
    }
    return child;
  }
  async delete() {
    for (const entry of await this.entries()) await this.client.remove(snapshotPath(this.id, entry.tic));
    await this.client.remove(indexPath(this.id));
  }
}

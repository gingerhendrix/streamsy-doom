// SPDX-License-Identifier: GPL-2.0-or-later
import { gunzipSync } from "fflate";
import { ProtocolClient, indexPath, snapshotPath } from "./protocol";
export const SNAPSHOT_INTERVAL = 21_000;
export interface Identity {
  version: number;
  buildId: string;
  wadSha256: string;
  skill: number;
  episode: number;
  map: number;
}
export interface Checkpoint extends Identity {
  tic: number;
  heap: Uint8Array;
}
export interface ReplayEngine {
  readonly identity: Identity;
  readonly tic: number;
  restore(checkpoint: Checkpoint): void;
  step(frame?: Uint8Array): Uint8Array;
}
export interface SnapshotEntry {
  tic: number;
  size: number;
}
export class SnapshotStore {
  constructor(
    readonly client: ProtocolClient,
    readonly id: string,
  ) {}
  async entries(): Promise<SnapshotEntry[]> {
    return await (await this.client.request(indexPath(this.id))).json();
  }
  async load(entry: SnapshotEntry): Promise<Checkpoint> {
    const bytes = new Uint8Array(
      await (await this.client.request(snapshotPath(this.id, entry.tic))).arrayBuffer(),
    );
    if (bytes.length !== entry.size) throw new Error("Snapshot size mismatch");
    const raw = gunzipSync(bytes),
      newline = raw.indexOf(10);
    if (newline < 0) throw new Error("Missing snapshot metadata");
    const metadata = JSON.parse(new TextDecoder().decode(raw.subarray(0, newline)));
    if (metadata.tic !== entry.tic) throw new Error("Snapshot tic mismatch");
    return { ...metadata, heap: raw.slice(newline + 1) };
  }
}

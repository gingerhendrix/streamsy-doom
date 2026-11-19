// SPDX-License-Identifier: GPL-2.0-or-later
import { gunzipSync } from "fflate";
import { parseJsonLine, splitFirstLine, TICS_PER_SECOND } from "./frames";
import { snapshotIndexPath, snapshotPath } from "./paths";
import type { ProtocolClient } from "./protocol";

const TEN_MINUTES_IN_SECONDS = 600;
export const SNAPSHOT_INTERVAL = TEN_MINUTES_IN_SECONDS * TICS_PER_SECOND;

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
    const index = await this.client.request(snapshotIndexPath(this.id));
    return await index.json();
  }

  async latestAtOrBefore(tic: number) {
    return (await this.entries()).filter((entry) => entry.tic <= tic).at(-1);
  }

  async load(entry: SnapshotEntry): Promise<Checkpoint> {
    const response = await this.client.request(snapshotPath(this.id, entry.tic));
    const compressed = new Uint8Array(await response.arrayBuffer());
    if (compressed.length !== entry.size) throw new Error("Snapshot size mismatch");
    const envelope = splitFirstLine(gunzipSync(compressed));
    if (!envelope) throw new Error("Missing snapshot metadata");
    const metadata = parseJsonLine(envelope.line);
    if (metadata.tic !== entry.tic) throw new Error("Snapshot tic mismatch");
    return { ...metadata, heap: envelope.rest.slice() };
  }
}

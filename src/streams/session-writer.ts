// SPDX-License-Identifier: GPL-2.0-or-later
import { concat } from "./bytes";
import type { SessionMetadata } from "./declarations";
import { isFrame, validTic } from "./frames";
import { batchPath, endPath, sessionPath } from "./paths";
import { BINARY, JSON_CONTENT, offsetOf, type ProtocolClient } from "./protocol";
import type { ReplayEngine } from "./snapshots";

export interface BatchBoundary {
  startTic: number;
  endTic: number;
  before: string;
  after: string;
}

export interface ManifestRecord {
  headerOffset?: string;
  batch?: BatchBoundary;
}

export const manifestBody = (records: ManifestRecord[]) => JSON.stringify(records);

export class SessionWriter {
  private appending = false;
  private appendedTics: number;

  constructor(
    readonly client: ProtocolClient,
    public row: SessionMetadata,
    public offset: string,
  ) {
    this.appendedTics = row.forkTic ?? 0;
  }

  get tic() {
    return this.appendedTics;
  }

  async append(frames: Uint8Array[]) {
    if (this.appending) throw new Error("Writer already in use");
    if (!frames.length || !frames.every(isFrame))
      throw new Error("Expected nonempty batch of 9-byte frames");
    validTic(this.tic + frames.length);
    this.appending = true;
    try {
      const batch = await this.appendFramesAtExpectedOffset(frames);
      await this.client.append(batchPath(this.row.id), manifestBody([{ batch }]), JSON_CONTENT);
      return batch;
    } finally {
      this.appending = false;
    }
  }

  private async appendFramesAtExpectedOffset(frames: Uint8Array[]): Promise<BatchBoundary> {
    const before = this.offset;
    const response = await this.client.append(sessionPath(this.row.id), concat(frames), BINARY, {
      "Stream-Expected-Offset": before,
    });
    this.offset = offsetOf(response);
    const batch = {
      startTic: this.tic,
      endTic: this.tic + frames.length,
      before,
      after: this.offset,
    };
    this.appendedTics = batch.endTic;
    return batch;
  }

  async record(
    engine: ReplayEngine,
    count: number,
    setInputBeforeTic: (tic: number) => void = () => {},
  ) {
    if (engine.tic !== this.tic) throw new Error("Engine/writer tic mismatch");
    if (!Number.isInteger(count) || count < 1) throw new Error("Invalid count");
    const frames: Uint8Array[] = [];
    for (let stepped = 0; stepped < count; stepped++) {
      setInputBeforeTic(engine.tic);
      frames.push(engine.step());
    }
    return this.append(frames);
  }

  async end() {
    await this.client.request(endPath(this.row.id), { method: "POST" });
    this.row = { ...this.row, ended: true };
  }
}

// SPDX-License-Identifier: GPL-2.0-or-later
import {
  FRAME_BYTES,
  frameOffsets,
  parseJsonLine,
  SESSION_FORMAT_VERSION,
  splitFirstLine,
  validTic,
} from "./frames";
import { sessionPath } from "./paths";
import { STREAM_START, type ProtocolClient } from "./protocol";
import { SnapshotStore, type Identity, type ReplayEngine } from "./snapshots";

export interface SessionHeader extends Identity {
  formatVersion: 1;
  forkedFrom: string | null;
  forkTic: number | null;
}

export interface FrameEvent {
  tic: number;
  frame: Uint8Array;
  offset: string;
}

export class SessionReader {
  header?: SessionHeader;
  readonly frames: Uint8Array[] = [];
  offset = STREAM_START;
  private cursor?: string;
  private upToDate = false;
  private closed = false;

  constructor(
    readonly client: ProtocolClient,
    readonly id: string,
  ) {}

  async pull(live = false, signal?: AbortSignal) {
    const page = await this.client.read(
      sessionPath(this.id),
      this.offset,
      live,
      signal,
      this.cursor,
    );
    const frameBytes = this.withoutHeader(page.bytes);
    if (frameBytes.length % FRAME_BYTES) throw new Error("Truncated frame batch");
    const events: FrameEvent[] = [];
    for (const start of frameOffsets(frameBytes)) {
      const frame = frameBytes.slice(start, start + FRAME_BYTES);
      this.frames.push(frame);
      events.push({ tic: this.frames.length, frame, offset: page.offset });
    }
    this.offset = page.offset;
    this.cursor = page.cursor;
    this.upToDate = page.upToDate;
    this.closed = page.closed;
    return events;
  }

  private withoutHeader(bytes: Uint8Array) {
    if (this.header || !bytes.length) return bytes;
    const split = splitFirstLine(bytes);
    if (!split) throw new Error("Missing session header");
    this.header = parseJsonLine(split.line);
    if (this.header?.formatVersion !== SESSION_FORMAT_VERSION)
      throw new Error("Unsupported session format");
    return split.rest;
  }

  async catchUp() {
    do {
      await this.pull();
    } while (!this.upToDate);
    return this;
  }

  async *follow(signal?: AbortSignal) {
    while (!signal?.aborted) {
      const waitForNewFrames = this.upToDate;
      for (const event of await this.pull(waitForNewFrames, signal)) yield event;
      if (this.closed) return;
    }
  }

  async seek(engine: ReplayEngine, targetTic: number) {
    validTic(targetTic);
    await this.catchUp();
    if (targetTic > this.frames.length) throw new Error("Seek beyond tail");
    this.assertRecordedBy(engine.identity);
    const snapshotTic = await this.restoreLatestSnapshot(engine, targetTic);
    for (let tic = engine.tic; tic < targetTic; tic++) engine.step(this.frames[tic]);
    return { snapshotTic, replayed: targetTic - snapshotTic };
  }

  private assertRecordedBy(identity: Identity) {
    for (const [field, value] of Object.entries(identity)) {
      if (this.header?.[field as keyof SessionHeader] !== value)
        throw new Error(`Session ${field} mismatch`);
    }
  }

  private async restoreLatestSnapshot(engine: ReplayEngine, targetTic: number) {
    const store = new SnapshotStore(this.client, this.id);
    const entry = await store.latestAtOrBefore(targetTic);
    if (entry) engine.restore(await store.load(entry));
    else if (engine.tic !== 0)
      throw new Error("Seek before first snapshot requires a fresh engine");
    return entry?.tic ?? 0;
  }
}

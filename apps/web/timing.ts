// SPDX-License-Identifier: GPL-2.0-or-later
import { TICS_PER_SECOND } from "../../src/streams/frames";

const MS_PER_TIC = 1000 / TICS_PER_SECOND;
const MAX_TICS_PER_PAINT = 8;

export class FixedStep {
  private previousPaint?: number;
  private unsteppedMs = 0;

  advance(now: number, step: () => void) {
    if (this.previousPaint !== undefined) this.unsteppedMs += now - this.previousPaint;
    this.previousPaint = now;
    for (let steps = 0; this.unsteppedMs >= MS_PER_TIC && steps < MAX_TICS_PER_PAINT; steps++) {
      step();
      this.unsteppedMs -= MS_PER_TIC;
    }
  }

  pause() {
    this.previousPaint = undefined;
    this.unsteppedMs = 0;
  }
}

export class FrameQueue {
  private frames: Uint8Array[] = [];
  private drainInProgress?: Promise<void>;
  error?: unknown;
  latency = 0;
  pending = 0;

  constructor(private readonly persist: (frames: Uint8Array[]) => Promise<void>) {}

  push(frame: Uint8Array) {
    this.frames.push(frame);
    this.pending++;
  }

  flush(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    return (this.drainInProgress ??= this.drainUntilEmptyOrFirstFailure());
  }

  private drainUntilEmptyOrFirstFailure() {
    return this.drain()
      .catch((error) => {
        this.error = error;
        throw error;
      })
      .finally(() => {
        this.drainInProgress = undefined;
      });
  }

  private async drain() {
    while (this.frames.length) {
      const frames = this.frames.splice(0);
      const started = performance.now();
      await this.persist(frames);
      this.pending -= frames.length;
      this.latency = performance.now() - started;
    }
  }
}

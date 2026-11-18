// SPDX-License-Identifier: GPL-2.0-or-later
// Keep time debt across paints; cap one paint's work without dropping game tics.
export class FixedStep {
  private previous?: number;
  private debt = 0;
  advance(now: number, step: () => void) {
    if (this.previous !== undefined) this.debt += now - this.previous;
    this.previous = now;
    let count = 0;
    while (this.debt >= 1000 / 35 && count++ < 8) {
      step();
      this.debt -= 1000 / 35;
    }
  }
  pause() {
    this.previous = undefined;
    this.debt = 0;
  }
}
// One serialized drain includes frame POST and manifest.
// Fail closed: never retry an ambiguous append or run later work after failure.
export class FrameQueue {
  private frames: Uint8Array[] = [];
  private running?: Promise<void>;
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
    if (this.running) return this.running;
    this.running = this.drain()
      .catch((error) => {
        this.error = error;
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async drain() {
    while (this.frames.length) {
      const frames = this.frames.splice(0),
        start = performance.now();
      await this.persist(frames);
      this.pending -= frames.length;
      this.latency = performance.now() - start;
    }
  }
}

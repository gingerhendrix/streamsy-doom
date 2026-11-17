// SPDX-License-Identifier: GPL-2.0-or-later
import { statNames } from "./stats.js";
export const keys: Readonly<Record<"up" | "down" | "left" | "right" | "strafeLeft" | "strafeRight" | "use" | "fire" | "run" | "strafe", number>>;
export interface EngineIdentity {
  version: number; buildId: string; wadSha256: string; skill: number; episode: number; map: number;
}
export interface EngineSnapshot extends EngineIdentity { tic: number; heap: Uint8Array }
export type EngineStats = Record<typeof statNames[number], number>;
export { statNames, readStats } from "./stats.js";
export interface Engine {
  readonly identity: EngineIdentity;
  readonly tic: number;
  readonly prndindex: number;
  readonly driftCount: number;
  stats(): EngineStats;
  hash(): number;
  key(code: number, down: boolean): void;
  step(frame?: Uint8Array): Uint8Array;
  snapshot(): EngineSnapshot;
  restore(snapshot: EngineSnapshot): void;
  render(): Uint8Array;
}
export function createEngine(wad: Uint8Array, options?: {
  skill?: number; episode?: number; map?: number; wasmBinary?: Uint8Array; print?: (line: string) => void;
}): Promise<Engine>;

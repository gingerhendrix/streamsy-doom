// SPDX-License-Identifier: GPL-2.0-or-later
import { DurableState } from "@streamsy/core";
import { Commit, Projection } from "@streamsy/projection";
import { Schema } from "effect";
import { concat } from "../streams/protocol";
import { Sessions, ReplayWake, Scores, SessionId } from "../streams/v2";

export const frameWake = Projection.wake({
  id: "doom-v2-frame-wake", params: { id: SessionId }, input: Sessions, output: ReplayWake,
});
export const CounterState = Schema.Struct({ header: Schema.Boolean, tail: Schema.Array(Schema.Number), tic: Schema.Number });
export type Counter = typeof CounterState.Type;
// The checkpoint retains an unfinished header or frame. Remote pages need not
// coincide with POSTs, and opaque storage offsets are never byte counts.
export function countFrames(state: Counter, pages: readonly Uint8Array[]): Counter {
  let bytes = concat([new Uint8Array(state.tail), ...pages]);
  let header = state.header;
  if (!header) {
    const end = bytes.indexOf(10);
    if (end === -1) {
      if (bytes.length > 65536) throw new Error("Session header too large");
      return { ...state, tail: [...bytes] };
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
    if (parsed.formatVersion !== 1) throw new Error("Unsupported session format");
    bytes = bytes.subarray(end + 1); header = true;
  }
  const frames = Math.floor(bytes.length / 9);
  return { header, tic: state.tic + frames, tail: [...bytes.subarray(frames * 9)] };
}
export const frameCounter = Projection.mapAccumBatch({
  id: "doom-v2-frame-counter", params: { id: SessionId }, inputs: { frames: Sessions }, outputs: { scores: Scores },
  commit: Commit.producer,
  state: { schema: CounterState, initial: { header: false, tail: [], tic: 0 } },
  mapAccumBatch: (state, batch, unit) => {
    const next = countFrames(state, batch.frames.items);
    return [next, { scores: [DurableState.upsert("stats", { id: unit.params.id, tic: next.tic })] }] as const;
  },
});

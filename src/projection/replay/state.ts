// SPDX-License-Identifier: GPL-2.0-or-later
import { Schema } from "effect";
import type { EngineStats } from "../../../engine/src/engine.js";
import { statNames } from "../../../engine/src/stats.js";
import { StatsRowSchema } from "../../streams/declarations";

export const IdentitySchema = Schema.Struct({
  version: Schema.Number,
  buildId: Schema.String,
  wadSha256: Schema.String,
  skill: Schema.Number,
  episode: Schema.Number,
  map: Schema.Number,
});

const EngineStatsSchema = Schema.Struct(
  Object.fromEntries(statNames.map((name) => [name, Schema.Number])) as Record<
    keyof EngineStats,
    typeof Schema.Number
  >,
);

export const ReplayState = Schema.Struct({
  header: Schema.NullOr(IdentitySchema),
  tail: Schema.Array(Schema.Number),
  tic: Schema.Number,
  last: Schema.NullOr(EngineStatsSchema),
  row: Schema.NullOr(StatsRowSchema),
  published: Schema.String,
  kills: Schema.Number,
  deaths: Schema.Number,
  items: Schema.Number,
  secrets: Schema.Number,
  verified: Schema.Boolean,
});
export type ReplayState = typeof ReplayState.Type;

export type DecoderState = Pick<ReplayState, "header" | "tail">;

export const initialReplayState = (): ReplayState => ({
  header: null,
  tail: [],
  tic: 0,
  last: null,
  row: null,
  published: "",
  kills: 0,
  deaths: 0,
  items: 0,
  secrets: 0,
  verified: true,
});

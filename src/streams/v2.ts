// SPDX-License-Identifier: GPL-2.0-or-later
import { Schema } from "effect";
import { Streamsy } from "@streamsy/core";
import { familyIdPattern } from "./ids";
export const SessionId = Schema.String.check(Schema.isPattern(familyIdPattern));
const params = { id: SessionId };
export class Sessions extends Streamsy.bytes<Sessions>()("DoomV2/Sessions", "doom/v2/sessions/:id", { params }) {}
export class Batches extends Streamsy.json<Batches>()("DoomV2/Batches", "doom/v2/batches/:id", {
  params, schema: Schema.Struct({
    headerOffset: Schema.optionalKey(Schema.String),
    batch: Schema.optionalKey(Schema.Struct({ startTic: Schema.Number, endTic: Schema.Number, before: Schema.String, after: Schema.String })),
  }),
}) {}
export class SnapshotIndex extends Streamsy.bytes<SnapshotIndex>()("DoomV2/SnapshotIndex", "doom/v2/snapshot-index/:id", { params }) {}
export class Snapshots extends Streamsy.bytes<Snapshots>()("DoomV2/Snapshots", "doom/v2/snapshots/:id/:tic", {
  params: { ...params, tic: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)) },
}) {}
export class ReplayWake extends Streamsy.wake<ReplayWake>()("DoomV2/ReplayWake", "doom/v2/replay-wake/:id", { params }) {}
export const SessionRowSchema = Schema.Struct({
  id: SessionId, playerName: Schema.String, skill: Schema.Number, episode: Schema.Number, map: Schema.Number,
  createdAt: Schema.String, status: Schema.Literals(["playing", "ended", "deleted"]), tickCount: Schema.Number,
  forkedFrom: Schema.NullOr(SessionId), forkTic: Schema.NullOr(Schema.Number),
});
export class LobbyStream extends Streamsy.state<LobbyStream>()("DoomV2/Lobby", "doom/v2/lobby", {
  params: {}, collections: { session: { schema: SessionRowSchema, key: "id" } },
}) {}
export const StatsRowSchema = Schema.Struct({
  id: SessionId, tic: Schema.Number, updatedTic: Schema.Number,
  health: Schema.Number, armor: Schema.Number, kills: Schema.Number, deaths: Schema.Number,
  items: Schema.Number, secrets: Schema.Number, levelKills: Schema.Number, levelItems: Schema.Number, levelSecrets: Schema.Number,
  levelTotalKills: Schema.Number, levelTotalItems: Schema.Number, levelTotalSecrets: Schema.Number,
  episode: Schema.Number, map: Schema.Number, weapon: Schema.Number, ammo: Schema.Number,
  alive: Schema.Boolean, live: Schema.Boolean, verified: Schema.Boolean,
});
export type StatsRow = typeof StatsRowSchema.Type;
export class Scores extends Streamsy.state<Scores>()("DoomV2/Scores", "doom/v2/scores", {
  params: {}, collections: { stats: { schema: StatsRowSchema, key: "id" } },
}) {}
export const familyStreams = Streamsy.group(Sessions, Batches, SnapshotIndex, Snapshots);
export const lobbyStreams = Streamsy.group(LobbyStream, Scores);
export const allStreams = Streamsy.group(Sessions, Batches, SnapshotIndex, Snapshots, ReplayWake, LobbyStream, Scores);

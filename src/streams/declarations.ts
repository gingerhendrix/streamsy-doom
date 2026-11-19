// SPDX-License-Identifier: GPL-2.0-or-later
import { Schema } from "effect";
import { Streamsy } from "@streamsy/core";
import type { StateEvent } from "./state";
import { sessionIdPattern } from "./ids";
export const SessionId = Schema.String.check(Schema.isPattern(sessionIdPattern));
const params = { id: SessionId };
export class Sessions extends Streamsy.bytes<Sessions>()(
  "DoomV2/Sessions",
  "doom/v2/sessions/:id",
  { params },
) {}
export class Batches extends Streamsy.json<Batches>()("DoomV2/Batches", "doom/v2/batches/:id", {
  params,
  schema: Schema.Struct({
    headerOffset: Schema.optionalKey(Schema.String),
    batch: Schema.optionalKey(
      Schema.Struct({
        startTic: Schema.Number,
        endTic: Schema.Number,
        before: Schema.String,
        after: Schema.String,
      }),
    ),
  }),
}) {}
export class ReplayWake extends Streamsy.wake<ReplayWake>()(
  "DoomV2/ReplayWake",
  "doom/v2/replay-wake/:id",
  { params },
) {}
export const SessionRowSchema = Schema.Struct({
  id: SessionId,
  playerName: Schema.String,
  skill: Schema.Number,
  episode: Schema.Number,
  map: Schema.Number,
  createdAt: Schema.String,
  ended: Schema.Boolean,
  forkedFrom: Schema.NullOr(SessionId),
  forkTic: Schema.NullOr(Schema.Number),
});
export type SessionMetadata = typeof SessionRowSchema.Type;
export const StatsRowSchema = Schema.Struct({
  id: SessionId,
  tic: Schema.Number,
  health: Schema.Number,
  armor: Schema.Number,
  kills: Schema.Number,
  deaths: Schema.Number,
  items: Schema.Number,
  secrets: Schema.Number,
  levelKills: Schema.Number,
  levelItems: Schema.Number,
  levelSecrets: Schema.Number,
  levelTotalKills: Schema.Number,
  levelTotalItems: Schema.Number,
  levelTotalSecrets: Schema.Number,
  episode: Schema.Number,
  map: Schema.Number,
  weapon: Schema.Number,
  ammo: Schema.Number,
  alive: Schema.Boolean,
  verified: Schema.Boolean,
});
export type StatsRow = typeof StatsRowSchema.Type;
export const PresenceRowSchema = Schema.Struct({ id: SessionId, live: Schema.Boolean });
export type PresenceRow = typeof PresenceRowSchema.Type;
export type GameEvent = StateEvent<StatsRow & PresenceRow & SessionMetadata>;
export class Game extends Streamsy.state<Game>()("DoomV2/Game", "doom/v2/games/:id", {
  params,
  collections: {
    stats: { schema: StatsRowSchema, key: "id" },
    presence: { schema: PresenceRowSchema, key: "id" },
    session: { schema: SessionRowSchema, key: "id" },
  },
}) {}
export const SummarySchema = Schema.Struct({
  tic: Schema.Number,
  episode: Schema.Number,
  map: Schema.Number,
  kills: Schema.Number,
  deaths: Schema.Number,
  items: Schema.Number,
  secrets: Schema.Number,
  alive: Schema.Boolean,
  verified: Schema.Boolean,
});
export const EntryRowSchema = Schema.Struct({
  ...SessionRowSchema.fields,
  score: Schema.NullOr(SummarySchema),
  live: Schema.Boolean,
});
export type EntryRow = typeof EntryRowSchema.Type;
export class Entries extends Streamsy.state<Entries>()("DoomV2/Entries", "doom/v2/entries", {
  params: {},
  collections: { entry: { schema: EntryRowSchema, key: "id" } },
}) {}
export class Leaderboard extends Streamsy.state<Leaderboard>()(
  "DoomV2/Leaderboard",
  "doom/v2/leaderboard",
  {
    params: {},
    collections: { game: { schema: EntryRowSchema, key: "id" } },
  },
) {}
export const familyStreams = Streamsy.group(Sessions, Batches);
export const lobbyStreams = Streamsy.group(Entries, Leaderboard);
export const allStreams = Streamsy.group(Sessions, Batches, ReplayWake, Game, Entries, Leaderboard);

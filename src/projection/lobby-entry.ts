// SPDX-License-Identifier: GPL-2.0-or-later
import { DurableState } from "@streamsy/core";
import { Commit, Projection } from "@streamsy/projection";
import { Duration, Effect, Schedule, Schema } from "effect";
import {
  Entries,
  Game,
  SessionId,
  SessionRowSchema,
  SummarySchema,
  type EntryRow,
  type GameEvent,
  type StatsRow,
} from "../streams/declarations";
import { publishIntervalOf } from "./publish-interval";

export const EntryState = Schema.Struct({
  session: Schema.NullOr(SessionRowSchema),
  score: Schema.NullOr(SummarySchema),
  live: Schema.Boolean,
  published: Schema.String,
  bucket: Schema.Number,
});
export type EntryState = typeof EntryState.Type;

export const initialEntry = (): EntryState => ({
  session: null,
  score: null,
  live: false,
  published: "",
  bucket: -1,
});

interface FoldedEntry {
  session: EntryState["session"];
  score: EntryState["score"];
  live: boolean;
  publishWithoutWaiting: boolean;
}

const summaryOf = (stats: StatsRow): NonNullable<EntryState["score"]> => ({
  tic: stats.tic,
  episode: stats.episode,
  map: stats.map,
  kills: stats.kills,
  deaths: stats.deaths,
  items: stats.items,
  secrets: stats.secrets,
  alive: stats.alive,
  verified: stats.verified,
});

function foldSessionEvent(entry: FoldedEntry, event: GameEvent) {
  if (event.headers.operation === "delete") entry.session = null;
  else if (event.value)
    entry.session = { ...entry.session, ...event.value } as NonNullable<EntryState["session"]>;
  entry.publishWithoutWaiting = true;
}

function foldPresenceEvent(entry: FoldedEntry, presence: NonNullable<GameEvent["value"]>) {
  if (typeof presence.live !== "boolean") return;
  if (presence.live !== entry.live) entry.publishWithoutWaiting = true;
  entry.live = presence.live;
}

function foldGameEvent(entry: FoldedEntry, event: GameEvent, id: string) {
  if (event.headers.control === "reset") {
    entry.session = null;
    entry.score = null;
    entry.live = false;
    entry.publishWithoutWaiting = true;
  }
  if (event.key !== id) return;
  if (event.type === "session") foldSessionEvent(entry, event);
  else if (event.type === "presence" && event.value) foldPresenceEvent(entry, event.value);
  else if (event.type === "stats" && event.value) entry.score = summaryOf(event.value as StatsRow);
}

export function entryBatch(
  state: EntryState,
  events: readonly GameEvent[],
  id: string,
  gone = false,
) {
  const entry: FoldedEntry = {
    session: state.session,
    score: state.score,
    live: state.live,
    publishWithoutWaiting: gone,
  };
  for (const event of events) foldGameEvent(entry, event, id);
  if (gone) entry.session = null;

  const { session, score, live } = entry;
  const row: EntryRow | null = session ? { ...session, score, live } : null;
  const serializedRow = JSON.stringify(row);
  const publishInterval = publishIntervalOf(score?.tic ?? 0);

  const rowChanged = serializedRow !== state.published;
  const neverPublished = !state.published;
  const isFirstScore = !state.score && score !== null;
  const enteredNextPublishInterval = publishInterval > state.bucket;
  const publish =
    rowChanged &&
    (entry.publishWithoutWaiting || neverPublished || isFirstScore || enteredNextPublishInterval);

  const next: EntryState = {
    session,
    score,
    live,
    published: publish ? serializedRow : state.published,
    bucket: publish ? publishInterval : state.bucket,
  };
  const publishedChange = row
    ? DurableState.upsert("entry", row)
    : DurableState.remove("entry", id);
  return { state: next, rows: publish ? [publishedChange] : [] };
}

const exponentialBackoffCappedAtThirtySeconds = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

export const lobbyEntry = Projection.mapAccumBatch({
  id: "doom-v2-lobby-entry",
  params: { id: SessionId },
  inputs: { game: Game },
  outputs: { entries: Entries },
  commit: Commit.producer,
  retry: { schedule: exponentialBackoffCappedAtThirtySeconds },
  state: { schema: EntryState, initial: initialEntry },
  mapAccumBatch: (state, batch, unit) =>
    Effect.sync(() => {
      const next = entryBatch(state, batch.game.items, unit.params.id, batch.game.gone);
      return [next.state, { entries: next.rows }] as const;
    }),
});

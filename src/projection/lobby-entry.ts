// SPDX-License-Identifier: GPL-2.0-or-later
import { DurableState } from "@streamsy/core";
import { Commit, Projection } from "@streamsy/projection";
import { Effect, Schema, Schedule, Duration } from "effect";
import {
  Game,
  Entries,
  SessionId,
  SessionRowSchema,
  SummarySchema,
  type StatsRow,
  type EntryRow,
  type GameEvent,
} from "../streams/v2";
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
/** Fold the whole unit, coalescing it to at most one lobby change. */
export function entryBatch(
  state: EntryState,
  events: readonly GameEvent[],
  id: string,
  gone = false,
) {
  let { session, score, live } = state,
    immediate = gone;
  for (const event of events) {
    if (event.headers.control === "reset") {
      session = null;
      score = null;
      live = false;
      immediate = true;
    }
    if (event.key !== id) continue;
    if (event.type === "session") {
      session =
        event.headers.operation === "delete"
          ? null
          : event.value
            ? ({ ...session, ...event.value } as NonNullable<typeof session>)
            : session;
      immediate = true;
    } else if (event.type === "presence" && event.value) {
      if (typeof event.value.live !== "boolean") continue;
      if (event.value.live !== live) immediate = true;
      live = event.value.live;
    } else if (event.type === "stats" && event.value) {
      const row = event.value as StatsRow;
      score = {
        tic: row.tic,
        episode: row.episode,
        map: row.map,
        kills: row.kills,
        deaths: row.deaths,
        items: row.items,
        secrets: row.secrets,
        alive: row.alive,
        verified: row.verified,
      };
    }
  }
  if (gone) session = null;
  const row: EntryRow | null = session ? { ...session, score, live } : null;
  // Tic makes bucket-boundary heartbeats visible even when the player stands still.
  const published = JSON.stringify(row);
  const bucket = Math.floor((score?.tic ?? 0) / 175);
  const emit =
    published !== state.published &&
    (immediate || !state.published || (!state.score && score !== null) || bucket > state.bucket);
  const next = {
    session,
    score,
    live,
    published: emit ? published : state.published,
    bucket: emit ? bucket : state.bucket,
  };
  const rows = emit
    ? [row ? DurableState.upsert("entry", row) : DurableState.remove("entry", id)]
    : [];
  return { state: next, rows };
}
export const lobbyEntry = Projection.mapAccumBatch({
  id: "doom-v2-lobby-entry",
  params: { id: SessionId },
  inputs: { game: Game },
  outputs: { entries: Entries },
  commit: Commit.producer,
  retry: {
    schedule: Schedule.exponential("1 second").pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.seconds(30))),
      ),
    ),
  },
  state: { schema: EntryState, initial: initialEntry },
  mapAccumBatch: (state, batch, unit) =>
    Effect.sync(() => {
      const next = entryBatch(state, batch.game.items, unit.params.id, batch.game.gone);
      return [next.state, { entries: next.rows }] as const;
    }),
});

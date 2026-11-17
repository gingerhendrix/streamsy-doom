// SPDX-License-Identifier: GPL-2.0-or-later
import { DurableState } from "@streamsy/core";
import { CheckpointStore, Commit, Projection } from "@streamsy/projection";
import { Clock, Effect, Option, Schema, Stream } from "effect";
import type { EngineStats } from "../../engine/src/engine.js";
import type { HeadlessEngine } from "../../engine/src/headless";
import { concat } from "../streams/protocol";
import { Sessions, Scores, SessionId, StatsRowSchema, type StatsRow } from "../streams/v2";
import { ReplayEngines } from "./engines";
const Identity = Schema.Struct({ version: Schema.Number, buildId: Schema.String, wadSha256: Schema.String,
  skill: Schema.Number, episode: Schema.Number, map: Schema.Number });
const EngineStatsSchema = Schema.Struct(Object.fromEntries([
  "tic", "gamestate", "episode", "map", "leveltime", "playerstate", "health", "armor", "kills", "items", "secrets",
  "totalKills", "totalItems", "totalSecrets", "weapon", "ammo",
].map(key => [key, Schema.Number])) as Record<keyof EngineStats, typeof Schema.Number>);
export const StatsState = Schema.Struct({
  header: Schema.NullOr(Identity), tail: Schema.Array(Schema.Number), tic: Schema.Number,
  last: Schema.NullOr(EngineStatsSchema), row: Schema.NullOr(StatsRowSchema), published: Schema.String,
  kills: Schema.Number, deaths: Schema.Number, items: Schema.Number, secrets: Schema.Number, verified: Schema.Boolean,
});
export type StatsState = typeof StatsState.Type;
export const initialStats = (): StatsState => ({ header: null, tail: [], tic: 0, last: null, row: null,
  published: "", kills: 0, deaths: 0, items: 0, secrets: 0, verified: true });
export function decodePages(state: Pick<StatsState, "header" | "tail">, pages: readonly Uint8Array[]) {
  let bytes = concat([new Uint8Array(state.tail), ...pages]), header = state.header;
  if (!header) {
    const end = bytes.indexOf(10);
    if (end === -1) {
      if (bytes.length > 65536) throw new Error("Session header too large");
      return { header, tail: [...bytes], frames: new Uint8Array(0) };
    }
    if (end > 65536) throw new Error("Session header too large");
    const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
    if (parsed.formatVersion !== 1) throw new Error("Unsupported session format");
    header = Schema.decodeUnknownSync(Identity)(parsed);
    bytes = bytes.subarray(end + 1);
  }
  const end = Math.floor(bytes.length / 9) * 9;
  return { header, tail: [...bytes.subarray(end)], frames: bytes.subarray(0, end) };
}
export function accumulate(state: StatsState, stats: EngineStats, verified: boolean, id: string): StatsState {
  const last = state.last;
  const reset = !last || stats.episode !== last.episode || stats.map !== last.map || stats.leveltime < last.leveltime;
  const delta = (key: "kills" | "items" | "secrets") => reset || stats[key] < last![key] ? stats[key] : stats[key] - last![key];
  const kills = state.kills + delta("kills"), items = state.items + delta("items"), secrets = state.secrets + delta("secrets");
  const deaths = state.deaths + Number(last?.playerstate === 0 && stats.playerstate === 1);
  const row: StatsRow = { id, tic: stats.tic, updatedTic: stats.tic, health: stats.health, armor: stats.armor,
    kills, deaths, items, secrets, levelKills: stats.kills, levelItems: stats.items, levelSecrets: stats.secrets,
    levelTotalKills: stats.totalKills, levelTotalItems: stats.totalItems, levelTotalSecrets: stats.totalSecrets,
    episode: stats.episode, map: stats.map, weapon: stats.weapon, ammo: stats.ammo,
    alive: stats.playerstate === 0 && stats.health > 0, verified: state.verified && verified, live: true };
  return { ...state, tic: stats.tic, last: stats, row, kills, deaths, items, secrets, verified: row.verified };
}
function visible(row: StatsRow) {
  const { tic, updatedTic, ...fields } = row;
  return JSON.stringify([fields, Math.floor(tic / 175)]);
}
/** Emit every qualifying tic, including inside a page. Unit boundaries cannot
 * drop intermediate deaths or change the resulting producer row sequence. */
export function replayPages(state: StatsState, pages: readonly Uint8Array[], engine: HeadlessEngine, id: string) {
  const decoded = decodePages(state, pages);
  let next: StatsState = { ...state, header: decoded.header, tail: decoded.tail };
  const rows: StatsRow[] = [];
  const publish = () => {
    if (next.row && visible(next.row) !== next.published) {
      next = { ...next, published: visible(next.row) }; rows.push(next.row!);
    }
  };
  if (decoded.header && !next.last) { next = accumulate(next, engine.stats(), true, id); publish(); }
  for (let at = 0; at < decoded.frames.length; at += 9) {
    const valid = engine.step(decoded.frames.subarray(at, at + 9));
    next = accumulate(next, engine.stats(), valid, id); publish();
  }
  return { state: next, rows };
}
function engineAt(id: string, state: StatsState) {
  return Effect.gen(function* () {
    const engines = yield* ReplayEngines;
    let engine = engines.cache.get(id);
    if (engine?.tic === state.tic) return engine;
    if (!state.header) throw new Error("Cannot rebuild before session header");
    if (engine) engine.reset(state.header);
    else engine = yield* Effect.promise(() => engines.create(state.header!));
    const rebuilt = engine;
    let decoder: Pick<StatsState, "header" | "tail"> = { header: null, tail: [] };
    if (state.tic) {
      yield* (yield* Sessions).read({ id }).pipe(
        Stream.takeUntil(() => rebuilt.tic >= state.tic),
        Stream.runForEach(batch => Effect.sync(() => {
          const parsed = decodePages(decoder, batch.items); decoder = parsed;
          for (let at = 0; at < parsed.frames.length && rebuilt.tic < state.tic; at += 9)
            rebuilt.step(parsed.frames.subarray(at, at + 9));
        })),
      );
    }
    if (rebuilt.tic !== state.tic) throw new Error("Replay history unavailable at checkpoint");
    engines.cache.set(id, rebuilt);
    return rebuilt;
  });
}
export const replayStats = Projection.mapAccumBatch({
  id: "doom-v2-replay-stats", params: { id: SessionId }, inputs: { frames: Sessions }, outputs: { scores: Scores },
  commit: Commit.producer, state: { schema: StatsState, initial: initialStats },
  mapAccumBatch: (state, batch, unit) => Effect.gen(function* () {
    const empty = [] as ReturnType<typeof DurableState.upsert<"stats", StatsRow>>[];
    if (batch.frames.gone) return [state, { scores: empty }] as const;
    const decoded = decodePages(state, batch.frames.items);
    if (!decoded.header || (state.last && !decoded.frames.length))
      return [{ ...state, tail: decoded.tail }, { scores: empty }] as const;
    const engine = yield* engineAt(unit.params.id, { ...state, header: decoded.header });
    const next = replayPages(state, batch.frames.items, engine, unit.params.id);
    return [next.state, { scores: next.rows.map(row => DurableState.upsert("stats", row)) }] as const;
  }),
});
export const IDLE_MS = 30_000;
// Wall clock presence is deliberately outside deterministic producer output.
// It reads only the settled stats checkpoint, never a player heap or lobby row.
export const replayIdle = Projection.process({
  id: "doom-v2-replay-idle", params: { id: SessionId }, inputs: { frames: Sessions }, commit: Commit.atLeastOnce,
  process: (batch, unit) => Effect.gen(function* () {
    if (batch.frames.gone) { (yield* ReplayEngines).cache.delete(unit.params.id); return; }
    const now = yield* Clock.currentTimeMillis;
    if (batch.frames.closed || batch.frames.items.some(bytes => bytes.length)) return Projection.wakeAt(now + IDLE_MS);
    if (Option.isNone(unit.due)) return;
    const store = yield* CheckpointStore;
    const stats = Option.getOrUndefined((yield* store.load({ id: replayStats.id, version: replayStats.version, generation: replayStats.generation, params: unit.params })).record);
    const idle = Option.getOrUndefined((yield* store.load({ id: unit.projectionId, version: unit.version, generation: unit.generation, params: unit.params })).record);
    // A failed/pending stats delivery is transport lag, not a drift verdict.
    if (!stats || stats.pending || stats.inputs.frames !== idle?.inputs.frames)
      return Projection.wakeAt(now + 1000);
    if (stats.state) {
      const state = Schema.decodeUnknownSync(StatsState)(JSON.parse(stats.state));
      if (state.row) yield* (yield* Scores).append({}, [{ type: "stats", key: unit.params.id, value: { ...state.row, live: false }, headers: { operation: "upsert" } }]);
    }
    (yield* ReplayEngines).cache.delete(unit.params.id);
  }),
});

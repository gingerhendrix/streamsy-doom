// SPDX-License-Identifier: GPL-2.0-or-later
import { CheckpointStore, Commit, Projection } from "@streamsy/projection";
import { Clock, Effect, Option } from "effect";
import { SnapshotTable } from "../../storage/snapshot-table";
import { Game, SessionId, Sessions } from "../../streams/declarations";
import { ReplayEngines } from "./engines";
import { replayStats } from "./projection";

export const IDLE_MS = 30_000;
const RECHECK_UNSETTLED_REPLAY_AFTER_MS = 1000;

const presence = (id: string, live: boolean) => ({
  type: "presence" as const,
  key: id,
  value: { id, live },
  headers: { operation: "upsert" as const },
});

const publishPresence = (id: string, live: boolean) =>
  Effect.gen(function* () {
    yield* (yield* Game).append({ id }, [presence(id, live)]);
  });

const forgetGameWhoseFramesExpired = (id: string) =>
  Effect.gen(function* () {
    const engines = yield* ReplayEngines;
    (yield* SnapshotTable).remove(id);
    engines.cache.delete(id);
    engines.live.delete(id);
  });

export const replayIdle = Projection.process({
  id: "doom-v2-replay-idle",
  params: { id: SessionId },
  inputs: { frames: Sessions },
  commit: Commit.atLeastOnce,
  process: (batch, unit) =>
    Effect.gen(function* () {
      const { id } = unit.params;
      if (batch.frames.gone) {
        yield* forgetGameWhoseFramesExpired(id);
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      const engines = yield* ReplayEngines;

      const framesArrivedOrStreamClosed =
        batch.frames.closed || batch.frames.items.some((bytes) => bytes.length);
      if (framesArrivedOrStreamClosed) {
        if (!engines.live.has(id)) {
          yield* publishPresence(id, true);
          engines.live.add(id);
        }
        return Projection.wakeAt(now + IDLE_MS);
      }

      const idleDeadlinePassed = Option.isSome(unit.due);
      if (!idleDeadlinePassed) return;

      const checkpoints = yield* CheckpointStore;
      const replayCheckpoint = Option.getOrUndefined(
        (yield* checkpoints.load({
          id: replayStats.id,
          version: replayStats.version,
          generation: replayStats.generation,
          params: unit.params,
        })).record,
      );
      const idleCheckpoint = Option.getOrUndefined(
        (yield* checkpoints.load({
          id: unit.projectionId,
          version: unit.version,
          generation: unit.generation,
          params: unit.params,
        })).record,
      );
      const replayHasSettledOnTheSameFrames =
        replayCheckpoint &&
        !replayCheckpoint.pending &&
        replayCheckpoint.inputs.frames === idleCheckpoint?.inputs.frames;
      if (!replayHasSettledOnTheSameFrames)
        return Projection.wakeAt(now + RECHECK_UNSETTLED_REPLAY_AFTER_MS);

      yield* publishPresence(id, false);
      engines.live.delete(id);
      engines.cache.delete(id);
    }),
});

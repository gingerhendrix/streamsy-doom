// SPDX-License-Identifier: GPL-2.0-or-later
import { DurableState } from "@streamsy/core";
import { Commit, Projection } from "@streamsy/projection";
import { Effect } from "effect";
import { SnapshotTable, SnapshotTooLarge } from "../../storage/snapshot-table";
import { concat } from "../../streams/bytes";
import { Game, ReplayWake, SessionId, Sessions, type StatsRow } from "../../streams/declarations";
import { FRAME_BYTES } from "../../streams/frames";
import { SNAPSHOT_INTERVAL } from "../../streams/snapshots";
import { engineAtCheckpoint } from "./engine-recovery";
import { decodePages } from "./pages";
import { replayDecoded } from "./replay-frames";
import { initialReplayState, ReplayState } from "./state";

const NO_ROWS = [] as ReturnType<typeof DurableState.upsert<"stats", StatsRow>>[];

function assertValidSnapshotInterval(intervalTics: number) {
  if (!Number.isInteger(intervalTics) || intervalTics < 1)
    throw new Error("Invalid snapshot interval");
}

const snapshotExpiryOf = (id: string) =>
  Effect.gen(function* () {
    const wake = yield* (yield* ReplayWake).head({ id });
    const expiry = Date.parse(wake.expiresAt ?? "");
    if (!Number.isFinite(expiry)) throw new Error("Replay wake needs absolute snapshot expiry");
    return expiry;
  });

function skipSnapshotThatIsTooLarge(error: unknown) {
  if (!(error instanceof SnapshotTooLarge)) throw error;
}

export function makeReplayStats({ snapshotInterval = SNAPSHOT_INTERVAL } = {}) {
  assertValidSnapshotInterval(snapshotInterval);
  return Projection.mapAccumBatch({
    id: "doom-v2-replay",
    params: { id: SessionId },
    inputs: { frames: Sessions },
    outputs: { game: Game },
    commit: Commit.transaction,
    state: { schema: ReplayState, initial: initialReplayState },
    mapAccumBatch: (state, batch, unit) =>
      Effect.gen(function* () {
        const { id } = unit.params;
        if (batch.frames.gone) return [state, { game: NO_ROWS }] as const;

        const decoded = decodePages(state, batch.frames.items);
        const hasNothingToReplay = !decoded.header || (state.last && !decoded.frames.length);
        if (hasNothingToReplay)
          return [{ ...state, tail: decoded.tail }, { game: NO_ROWS }] as const;

        const engine = yield* engineAtCheckpoint(id, { ...state, header: decoded.header });
        const table = yield* SnapshotTable;
        const ticAfterUnit = state.tic + decoded.frames.length / FRAME_BYTES;
        const unitReachesSnapshotTic =
          Math.floor(ticAfterUnit / snapshotInterval) > Math.floor(state.tic / snapshotInterval);
        const snapshotExpiry = unitReachesSnapshotTic ? yield* snapshotExpiryOf(id) : 0;

        const writeSnapshotWithResumePoint = async (consumedFrameBytes: number) => {
          const framesReadButNotYetReplayed = concat([
            decoded.frames.subarray(consumedFrameBytes),
            new Uint8Array(decoded.tail),
          ]);
          try {
            table.write(id, engine.tic, await engine.snapshot(), snapshotExpiry, {
              offset: batch.frames.nextOffset,
              frames: framesReadButNotYetReplayed,
            });
          } catch (error) {
            skipSnapshotThatIsTooLarge(error);
          }
        };

        const replayed = yield* Effect.promise(() =>
          replayDecoded(state, decoded, engine, id, {
            intervalTics: snapshotInterval,
            writeAfter: writeSnapshotWithResumePoint,
          }),
        );
        const statsRows = replayed.rows.map((row) => DurableState.upsert("stats", row));
        return [replayed.state, { game: statsRows }] as const;
      }),
  });
}

export const replayStats = makeReplayStats();

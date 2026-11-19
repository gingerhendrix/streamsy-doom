// SPDX-License-Identifier: GPL-2.0-or-later
import { Effect, Stream } from "effect";
import type { EngineIdentity } from "../../../engine/src/engine.js";
import type { HeadlessEngine } from "../../../engine/src/headless";
import { SnapshotTable, type StoredSnapshot } from "../../storage/snapshot-table";
import { Sessions } from "../../streams/declarations";
import { frameAt, frameOffsets } from "../../streams/frames";
import { ReplayEngines } from "./engines";
import { decodePages } from "./pages";
import type { DecoderState, ReplayState } from "./state";

function restoreSnapshot(engine: HeadlessEngine, snapshot: StoredSnapshot) {
  engine.restore(snapshot.bytes);
  if (engine.tic !== snapshot.tic) throw new Error("Snapshot table tic mismatch");
}

function replayerUpTo(
  targetTic: number,
  engine: HeadlessEngine,
  header: EngineIdentity,
  snapshot: StoredSnapshot | undefined,
) {
  const pagesStartAfterSnapshot = snapshot?.resume !== undefined;
  let decoder: DecoderState = { header: pagesStartAfterSnapshot ? header : null, tail: [] };
  let nextFrameIndex = pagesStartAfterSnapshot ? snapshot!.tic : 0;

  return (pages: readonly Uint8Array[]) => {
    const decoded = decodePages(decoder, pages);
    decoder = decoded;
    for (const offset of frameOffsets(decoded.frames)) {
      if (engine.tic >= targetTic) return;
      const snapshotAlreadyContainsFrame = nextFrameIndex++ < engine.tic;
      if (!snapshotAlreadyContainsFrame) engine.step(frameAt(decoded.frames, offset));
    }
  };
}

export const engineAtCheckpoint = (id: string, state: ReplayState) =>
  Effect.gen(function* () {
    const engines = yield* ReplayEngines;
    const cached = engines.cache.get(id);
    if (cached?.tic === state.tic) return cached;

    const header = state.header;
    if (!header) throw new Error("Cannot rebuild before session header");
    if (cached) cached.reset(header);
    const engine = cached ?? (yield* Effect.promise(() => engines.create(header)));

    const snapshot = (yield* SnapshotTable).latest(id, state.tic);
    if (snapshot) yield* Effect.sync(() => restoreSnapshot(engine, snapshot));

    const replay = replayerUpTo(state.tic, engine, header, snapshot);
    if (snapshot?.resume) replay([snapshot.resume.frames]);
    if (engine.tic < state.tic) {
      const readFrom = snapshot?.resume ? { offset: snapshot.resume.offset } : undefined;
      yield* (yield* Sessions).read({ id }, readFrom).pipe(
        Stream.takeUntil(() => engine.tic >= state.tic),
        Stream.runForEach((batch) => Effect.sync(() => replay(batch.items))),
      );
    }
    if (engine.tic !== state.tic) throw new Error("Replay history unavailable at checkpoint");
    engines.cache.set(id, engine);
    return engine;
  });

// SPDX-License-Identifier: GPL-2.0-or-later
import type { HeadlessEngine } from "../../../engine/src/headless";
import type { StatsRow } from "../../streams/declarations";
import { FRAME_BYTES, frameAt, frameOffsets } from "../../streams/frames";
import { decodePages, type DecodedPages } from "./pages";
import { accumulate, whatViewersSee } from "./score";
import type { ReplayState } from "./state";

export interface SnapshotSchedule {
  intervalTics: number;
  writeAfter(consumedFrameBytes: number): Promise<void>;
}

export async function replayDecoded(
  state: ReplayState,
  decoded: DecodedPages,
  engine: HeadlessEngine,
  id: string,
  snapshots?: SnapshotSchedule,
) {
  let next: ReplayState = { ...state, header: decoded.header, tail: decoded.tail };
  const rows: StatsRow[] = [];

  const publishRowIfViewersSeeAChange = () => {
    if (!next.row) return;
    const visible = whatViewersSee(next.row);
    if (visible === next.published) return;
    next = { ...next, published: visible };
    rows.push(next.row!);
  };
  const recordEngineStats = (inputMatchedRecording: boolean) => {
    next = accumulate(next, engine.stats(), inputMatchedRecording, id);
    publishRowIfViewersSeeAChange();
  };

  const isFirstUnitWithHeader = decoded.header && !next.last;
  if (isFirstUnitWithHeader) recordEngineStats(true);
  for (const offset of frameOffsets(decoded.frames)) {
    recordEngineStats(engine.step(frameAt(decoded.frames, offset)));
    if (snapshots && next.tic % snapshots.intervalTics === 0)
      await snapshots.writeAfter(offset + FRAME_BYTES);
  }
  return { state: next, rows };
}

export const replayPages = (
  state: ReplayState,
  pages: readonly Uint8Array[],
  engine: HeadlessEngine,
  id: string,
) => replayDecoded(state, decodePages(state, pages), engine, id);

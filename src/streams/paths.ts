// SPDX-License-Identifier: GPL-2.0-or-later
import { validTic } from "./frames";
import { validSessionId } from "./ids";

export const V2_PREFIX = "doom/v2";

export const sessionPath = (id: string) => `${V2_PREFIX}/sessions/${validSessionId(id)}`;
export const batchPath = (id: string) => `${V2_PREFIX}/batches/${validSessionId(id)}`;

export const SNAPSHOTS_PREFIX = `${V2_PREFIX}/server-snapshots`;
export const snapshotIndexPath = (id: string) => `${SNAPSHOTS_PREFIX}/${validSessionId(id)}`;
export const snapshotPath = (id: string, tic: number) =>
  `${snapshotIndexPath(id)}/${validTic(tic)}`;

export const gameStatePath = (id: string) => `${V2_PREFIX}/games/${id}`;
export const leaderboardStatePath = `${V2_PREFIX}/leaderboard`;
export const entriesStatePath = `${V2_PREFIX}/entries`;

export const STATE_SNAPSHOT_PREFIX = `${V2_PREFIX}/state-snapshot`;
export const gameStateSnapshotPath = (id: string) => `${STATE_SNAPSHOT_PREFIX}/games/${id}`;
export const leaderboardStateSnapshotPath = `${STATE_SNAPSHOT_PREFIX}/leaderboard`;

export const BOOTSTRAP_PREFIX = `${V2_PREFIX}/bootstrap`;
export const bootstrapPath = (id: string) => `${BOOTSTRAP_PREFIX}/${id}`;
export const endPath = (id: string) => `${V2_PREFIX}/end/${id}`;
export const deletePath = (id: string) => `${V2_PREFIX}/delete/${id}`;

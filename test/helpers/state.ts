// SPDX-License-Identifier: GPL-2.0-or-later
import type { EntryRow, StatsRow } from "../../src/streams/v2";
export const idOf = (n: number) => "a".repeat(32) + "_" + n.toString(16).padStart(32, "0");
export const entryOf = (n: number): EntryRow => ({ id: idOf(n), playerName: `Player ${n}`, createdAt: new Date(1_790_000_000_000 + n).toISOString(), skill: 3, episode: 1, map: 1, ended: false, forkedFrom: null, forkTic: null, score: null, live: false });
export const statsOf = (id: string, tic: number): StatsRow => ({ id, tic, health: 100, armor: 0, kills: tic, deaths: 0, items: 0, secrets: 0, levelKills: 0, levelItems: 0, levelSecrets: 0, levelTotalKills: 0, levelTotalItems: 0, levelTotalSecrets: 0, episode: 1, map: 1, weapon: 2, ammo: 50, alive: true, verified: true });

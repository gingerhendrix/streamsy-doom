// SPDX-License-Identifier: GPL-2.0-or-later
import type { EngineStats } from "../../../engine/src/engine.js";
import type { StatsRow } from "../../streams/declarations";
import { publishIntervalOf } from "../publish-interval";
import type { ReplayState } from "./state";

const PLAYER_ALIVE = 0;
const PLAYER_DEAD = 1;

type LevelCounter = "kills" | "items" | "secrets";

export function accumulate(
  state: ReplayState,
  stats: EngineStats,
  verified: boolean,
  id: string,
): ReplayState {
  const previous = state.last;
  const levelStartedOver =
    !previous ||
    stats.episode !== previous.episode ||
    stats.map !== previous.map ||
    stats.leveltime < previous.leveltime;
  const gainedSincePrevious = (counter: LevelCounter) =>
    levelStartedOver || stats[counter] < previous![counter]
      ? stats[counter]
      : stats[counter] - previous![counter];
  const diedOnThisTic = previous?.playerstate === PLAYER_ALIVE && stats.playerstate === PLAYER_DEAD;

  const kills = state.kills + gainedSincePrevious("kills");
  const items = state.items + gainedSincePrevious("items");
  const secrets = state.secrets + gainedSincePrevious("secrets");
  const deaths = state.deaths + Number(diedOnThisTic);
  const row: StatsRow = {
    id,
    tic: stats.tic,
    health: stats.health,
    armor: stats.armor,
    kills,
    deaths,
    items,
    secrets,
    levelKills: stats.kills,
    levelItems: stats.items,
    levelSecrets: stats.secrets,
    levelTotalKills: stats.totalKills,
    levelTotalItems: stats.totalItems,
    levelTotalSecrets: stats.totalSecrets,
    episode: stats.episode,
    map: stats.map,
    weapon: stats.weapon,
    ammo: stats.ammo,
    alive: stats.playerstate === PLAYER_ALIVE && stats.health > 0,
    verified: state.verified && verified,
  };
  return {
    ...state,
    tic: stats.tic,
    last: stats,
    row,
    kills,
    deaths,
    items,
    secrets,
    verified: row.verified,
  };
}

export function whatViewersSee(row: StatsRow) {
  const { tic, ...fields } = row;
  return JSON.stringify([fields, publishIntervalOf(tic)]);
}

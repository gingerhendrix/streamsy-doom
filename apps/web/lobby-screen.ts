// SPDX-License-Identifier: GPL-2.0-or-later
import {
  createSession,
  followState,
  leaderboardStatePath,
  leaderboardStateSnapshotPath,
  StateRows,
  type StateEvent,
} from "../../src/streams";
import type { EntryRow } from "../../src/streams/declarations";
import { client } from "./client";
import { find, setText } from "./dom";
import { createEngine } from "./engine-assets";
import { refreshAgeCells, renderLeaderboard } from "./leaderboard-table";
import { rememberOwnedSession } from "./owned-sessions";
import { leaveCurrentScreen, onLeavingScreen, screens } from "./screens";
import { action, mainElement, report } from "./shell";
import { lobbyHtml } from "./templates";

const DEFAULT_PLAYER_NAME = "Player";
const REFRESH_AGES_EVERY_MS = 1000;

async function startNewGame() {
  const playerName = find<HTMLInputElement>("#name").value.trim() || DEFAULT_PLAYER_NAME;
  const skill = Number(find<HTMLInputElement>("#skill input:checked").value);
  find<HTMLButtonElement>("form button").disabled = true;
  try {
    const game = await createEngine({ skill });
    const writer = await createSession(client, { playerName, identity: game.identity });
    rememberOwnedSession(writer.row.id);
    await screens().play(game, writer);
  } finally {
    const submitIfLobbyIsStillShown = document.querySelector<HTMLButtonElement>("form button");
    if (submitIfLobbyIsStillShown) submitIfLobbyIsStillShown.disabled = false;
  }
}

function followLeaderboard(signal: AbortSignal) {
  const entries = new StateRows<EntryRow>("game");
  const receivedAt = new Map<string, number>();
  void followState<StateEvent<EntryRow>>(client, {
    snapshot: leaderboardStateSnapshotPath,
    stream: leaderboardStatePath,
    signal,
    onBatch: (events) => {
      entries.apply(events);
      for (const event of events) if (event.key) receivedAt.set(event.key, Date.now());
      if (!signal.aborted) renderLeaderboard([...entries.rows.values()], receivedAt);
    },
    onTransport: (transport) => {
      if (!signal.aborted) setText("#transport", `Leaderboard: ${transport}`);
    },
  }).catch((error) => {
    if (!signal.aborted) report(error);
  });
}

export async function showLobby() {
  await leaveCurrentScreen();
  onLeavingScreen();
  history.replaceState(null, "", location.pathname);
  mainElement().innerHTML = lobbyHtml;
  find("form").addEventListener("submit", (event) => {
    event.preventDefault();
    void action(startNewGame);
  });

  const leaving = new AbortController();
  onLeavingScreen(async () => leaving.abort());
  followLeaderboard(leaving.signal);
  const ageTimer = setInterval(refreshAgeCells, REFRESH_AGES_EVERY_MS);
  onLeavingScreen(async () => {
    leaving.abort();
    clearInterval(ageTimer);
  });
}

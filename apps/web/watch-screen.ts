// SPDX-License-Identifier: GPL-2.0-or-later
import type { Engine } from "../../engine/src/engine.js";
import { forkSession, SessionReader, TICS_PER_SECOND } from "../../src/streams";
import { client, lobby } from "./client";
import { find, setText } from "./dom";
import { createEngine, paint } from "./engine-assets";
import { GameHud } from "./hud";
import { rememberOwnedSession } from "./owned-sessions";
import { leaveCurrentScreen, onLeavingScreen, screens } from "./screens";
import { action, onButtonClick, report } from "./shell";
import { showStage, showWatchUrl } from "./stage";
import { watchControlsHtml } from "./templates";

const MAX_CATCH_UP_TICS_PER_PAINT = 4 * TICS_PER_SECOND;
const MAX_PLAYER_NAME_LENGTH = 40;

const seekInfo = (snapshotTic: number, tic: number) => `Snapshot ${snapshotTic} → tic ${tic}`;

export async function watch(id: string) {
  await leaveCurrentScreen();
  onLeavingScreen();
  const session = await lobby.get(id);
  const liveReader = await new SessionReader(client, id).catchUp();
  const header = liveReader.header;
  if (!header) throw new Error("Missing engine settings");
  let game = await createEngine(header);
  const initialSeek = await liveReader.seek(game, liveReader.frames.length);

  showStage("Watching", session, watchControlsHtml);
  showWatchUrl(id);
  const scrub = find<HTMLInputElement>("#scrub");
  const forkButton = find<HTMLButtonElement>("#fork");
  let followingLive = true;
  let seeking = false;
  let stopped = false;
  let animationFrame = 0;
  setText("#seek-info", seekInfo(initialSeek.snapshotTic, game.tic));

  const leaving = new AbortController();
  const hud = new GameHud(find("#game-hud"), client, id, {
    head: () => liveReader.frames.length,
    onError: report,
  });
  onLeavingScreen(async () => {
    stopped = true;
    hud.dispose();
    leaving.abort();
    cancelAnimationFrame(animationFrame);
  });

  const keepLiveReaderFramesCurrent = async () => {
    for await (const _frame of liveReader.follow(leaving.signal));
  };
  void keepLiveReaderFramesCurrent().catch((error) => {
    if (leaving.signal.aborted) return;
    followingLive = false;
    report(error);
  });

  const engineSeekedTo = async (tic: number): Promise<{ engine: Engine; snapshotTic: number }> => {
    const engine = await createEngine(header);
    const readerUsedOnlyForThisSeek = new SessionReader(client, id);
    const { snapshotTic } = await readerUsedOnlyForThisSeek.seek(engine, tic);
    return { engine, snapshotTic };
  };

  const replayReceivedFrames = () => {
    const head = liveReader.frames.length;
    for (let steps = 0; game.tic < head && steps < MAX_CATCH_UP_TICS_PER_PAINT; steps++)
      game.step(liveReader.frames[game.tic]);
  };
  const showMetrics = () => {
    const head = liveReader.frames.length;
    const mode = followingLive ? "Following live" : "Scrubbed";
    setText("#metrics", `Tic ${game.tic} / ${head} · Live lag ${head - game.tic} tics · ${mode}`);
  };
  const onAnimationFrame = () => {
    if (stopped) return;
    try {
      if (followingLive && !seeking) replayReceivedFrames();
      if (!seeking) paint(game);
      scrub.max = String(liveReader.frames.length);
      if (followingLive) scrub.value = String(game.tic);
      showMetrics();
      animationFrame = requestAnimationFrame(onAnimationFrame);
    } catch (error) {
      followingLive = false;
      report(error);
    }
  };

  const seekToScrubPosition = async () => {
    followingLive = false;
    seeking = true;
    forkButton.disabled = true;
    scrub.disabled = true;
    try {
      const seeked = await engineSeekedTo(Number(scrub.value));
      game = seeked.engine;
      paint(game);
      setText("#seek-info", seekInfo(seeked.snapshotTic, game.tic));
    } finally {
      seeking = false;
      forkButton.disabled = false;
      scrub.disabled = false;
    }
  };

  const forkAtCurrentTic = async () => {
    followingLive = false;
    forkButton.disabled = true;
    try {
      const tic = game.tic;
      const { engine: engineWithNoHeldKeys } = await engineSeekedTo(tic);
      const playerName = `${session.playerName} (fork)`.slice(0, MAX_PLAYER_NAME_LENGTH);
      const child = await forkSession(client, id, tic, { playerName });
      rememberOwnedSession(child.row.id);
      await screens().play(engineWithNoHeldKeys, child);
    } finally {
      forkButton.disabled = false;
    }
  };

  scrub.addEventListener("input", () => {
    followingLive = false;
  });
  scrub.addEventListener("change", () => void action(seekToScrubPosition));
  onButtonClick("live", async () => {
    followingLive = true;
  });
  onButtonClick("fork", forkAtCurrentTic);
  paint(game);
  animationFrame = requestAnimationFrame(onAnimationFrame);
}

// SPDX-License-Identifier: GPL-2.0-or-later
import type { Engine } from "../../engine/src/engine.js";
import { SNAPSHOT_INTERVAL, SnapshotStore, type SessionWriter } from "../../src/streams";
import { client } from "./client";
import { find, setText } from "./dom";
import { engineKeys, paint } from "./engine-assets";
import { GameHud, TicClock } from "./hud";
import { KeyboardControls } from "./keyboard";
import { leaveCurrentScreen, onLeavingScreen, screens } from "./screens";
import { onButtonClick, report } from "./shell";
import { showStage, showWatchUrl } from "./stage";
import { playControlsHtml } from "./templates";
import { FixedStep, FrameQueue } from "./timing";

const FRAMES_PER_APPEND = 5;
const POLL_SNAPSHOTS_EVERY_MS = 5000;

export async function play(game: Engine, writer: SessionWriter) {
  await leaveCurrentScreen();
  const sessionId = writer.row.id;
  showStage("Playing", writer.row, playControlsHtml);
  showWatchUrl(sessionId);
  const canvas = find<HTMLCanvasElement>("canvas");

  const snapshots = new SnapshotStore(client, sessionId);
  const latestSnapshotTic = async () => (await snapshots.entries()).at(-1)?.tic ?? 0;
  let snapshotTic = await latestSnapshotTic();
  let stopped = false;
  let animationFrame = 0;

  const unsentFrames = new FrameQueue(async (frames) => {
    await writer.append(frames);
  });
  const snapshotPoll = window.setInterval(() => {
    void latestSnapshotTic()
      .then((tic) => {
        snapshotTic = tic;
      })
      .catch(stopAndReport);
  }, POLL_SNAPSHOTS_EVERY_MS);

  const gameClock = new FixedStep();
  const wallTimeOfTic = new TicClock();
  wallTimeOfTic.record(game.tic, performance.now());
  const hud = new GameHud(find("#game-hud"), client, sessionId, {
    head: () => game.tic,
    clock: wallTimeOfTic,
    onError: report,
  });

  const keyboard = new KeyboardControls(await engineKeys(), (code, down) => game.key(code, down));
  const releaseKeysAndPause = () => {
    keyboard.release();
    gameClock.pause();
  };
  releaseKeysAndPause();
  const onKey = (event: KeyboardEvent) => keyboard.handle(event, document.activeElement === canvas);
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  window.addEventListener("blur", releaseKeysAndPause);
  canvas.addEventListener("blur", releaseKeysAndPause);

  const stepOneTic = () => {
    const frame = game.step();
    wallTimeOfTic.record(game.tic, performance.now());
    unsentFrames.push(frame);
  };
  const showMetrics = () => {
    const snapshot = snapshotTic || `pending at ${SNAPSHOT_INTERVAL}`;
    setText(
      "#metrics",
      `Tic ${game.tic} · Pending frames ${unsentFrames.pending} · Batch ${unsentFrames.latency.toFixed(1)} ms · Snapshot ${snapshot}`,
    );
  };
  const onAnimationFrame = (now: number) => {
    if (stopped) return;
    try {
      if (document.hasFocus()) gameClock.advance(now, stepOneTic);
      else gameClock.pause();
      if (unsentFrames.pending >= FRAMES_PER_APPEND) void unsentFrames.flush().catch(stopAndReport);
      if (unsentFrames.error) throw unsentFrames.error;
      paint(game);
      showMetrics();
      animationFrame = requestAnimationFrame(onAnimationFrame);
    } catch (error) {
      stopAndReport(error);
    }
  };

  const stop = () => {
    stopped = true;
    hud.dispose();
    cancelAnimationFrame(animationFrame);
    clearInterval(snapshotPoll);
    releaseKeysAndPause();
  };
  function stopAndReport(error: unknown) {
    stop();
    report(error);
  }

  onLeavingScreen(async () => {
    stop();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    window.removeEventListener("blur", releaseKeysAndPause);
    canvas.removeEventListener("blur", releaseKeysAndPause);
    await unsentFrames.flush();
    await writer.end();
  });

  onButtonClick("end", () => screens().showLobby());
  canvas.focus();
  paint(game);
  animationFrame = requestAnimationFrame(onAnimationFrame);
}

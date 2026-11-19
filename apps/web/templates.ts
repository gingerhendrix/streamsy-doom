// SPDX-License-Identifier: GPL-2.0-or-later
const html = (...fragments: string[]) => fragments.join("");

export const CANVAS_WIDTH = 320;
export const CANVAS_HEIGHT = 200;

const skills = [
  { value: 1, label: "I'm too young to die" },
  { value: 2, label: "Hey, not too rough" },
  { value: 3, label: "Hurt me plenty", selected: true },
  { value: 4, label: "Ultra-Violence" },
  { value: 5, label: "Nightmare!" },
];

const skillOption = (skill: (typeof skills)[number]) =>
  html(
    `<label><input type="radio" name="skill" value="${skill.value}"${skill.selected ? " checked" : ""}>`,
    `<span>${skill.label}</span></label>`,
  );

export const shellHtml = html(
  `<header><h1>Streamsy <span>Doom</span></h1><p>A game made of streams.</p></header>`,
  `<p id="error" role="alert"></p>`,
  `<main></main>`,
  `<footer>`,
  `<a id="source">Source: GPL-2.0-or-later</a> · <span id="source-note"></span><br>`,
  `Game data: <a href="/wad/manifest.json">WAD manifest and notices</a>. `,
  `Default: Freedoom Phase 1 0.13.0 · BSD-3-Clause. Engine: DoomGeneric / id Software. No audio.<br>`,
  `Display font: Jersey 10 · <a href="/fonts/OFL.txt">SIL Open Font License 1.1</a>.`,
  `</footer>`,
);

export const lobbyHtml = html(
  `<section class="new-game">`,
  `<h2>Start a new timeline</h2>`,
  `<p>Play, watch live, or rewind and take the game in another direction.</p>`,
  `<form>`,
  `<label>Player name<input id="name" maxlength="40" value="Player" required></label>`,
  `<fieldset class="skill-menu" id="skill"><legend>Choose your skill</legend>`,
  ...skills.map(skillOption),
  `</fieldset>`,
  `<button class="primary">New game</button>`,
  `</form>`,
  `</section>`,
  `<section class="tally">`,
  `<h2>Sessions <span id="count"></span></h2>`,
  `<p id="transport">Connecting…</p>`,
  `<div id="sessions">Loading lobby…</div>`,
  `<p class="hint">`,
  `Lobby summaries publish at most every five seconds of play, with immediate presence and session changes. `,
  `¹Age is time since this tab received the score at its projected tic; initial history has no server timestamp. `,
  `The newest 50 sessions load from a snapshot.`,
  `</p>`,
  `</section>`,
);

export const stageHtml = (controlsHtml: string) =>
  html(
    `<div class="toolbar"><h2 id="heading"></h2><button id="leave">Lobby</button></div>`,
    `<p id="session"></p>`,
    `<div class="stage"><div class="screen">`,
    `<canvas width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" tabindex="0" aria-label="Doom game; click to focus keyboard"></canvas>`,
    `<div class="crt" aria-hidden="true"></div>`,
    `</div></div>`,
    `<div class="metrics" aria-live="off" id="metrics"></div>`,
    `<div class="hud" id="game-hud"></div>`,
    controlsHtml,
  );

export const playControlsHtml = html(
  `<p class="controls">Click the game to focus. `,
  `<kbd>W</kbd>/<kbd>S</kbd> move forward/back · `,
  `<kbd>A</kbd>/<kbd>D</kbd> turn left/right · `,
  `<kbd>Space</kbd> fires · `,
  `<kbd>Enter</kbd> uses/interacts. `,
  `Arrows also move/turn · `,
  `<kbd>Ctrl</kbd> also fires · `,
  `<kbd>Alt</kbd> strafes · `,
  `<kbd>Shift</kbd> runs · `,
  `<kbd>,</kbd>/<kbd>.</kbd> strafe · `,
  `<kbd>1</kbd>–<kbd>7</kbd> selects a weapon. `,
  `Blur pauses local play and releases keys.</p>`,
  `<button id="end">End game & return to lobby</button>`,
);

export const watchControlsHtml = html(
  `<label class="scrub">Timeline — release to seek`,
  `<input id="scrub" type="range" min="0" max="0" value="0" step="1"></label>`,
  `<div class="toolbar">`,
  `<button id="live" class="primary">Follow live</button>`,
  `<button id="fork">Fork here</button>`,
  `<span id="seek-info"></span>`,
  `</div>`,
);

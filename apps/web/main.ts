// SPDX-License-Identifier: GPL-2.0-or-later
import { Lobby, ProtocolClient, SessionReader, SnapshotStore, createSession, deleteSession, forkSession, type SessionWriter, SNAPSHOT_INTERVAL, StateRows, followJson, type StateEvent } from "../../src/streams";
import type { SessionMetadata, StatsRow } from "../../src/streams/v2";
import type { Engine } from "../../engine/src/engine.js";
import { FixedStep, FrameQueue } from "./timing";
import { KeyboardControls } from "./keyboard";
import { loadWad } from "../../src/wad";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><h1>Streamsy <span>Doom</span></h1><p>A game made of streams.</p></header><p id="error" role="alert"></p><main></main><footer><a id="source">Source: GPL-2.0-or-later</a> · <span id="source-note"></span><br>Game data: <a href="/wad/manifest.json">WAD manifest and notices</a>. Default: Freedoom Phase 1 0.13.0 · BSD-3-Clause. Engine: DoomGeneric / id Software. No audio.</footer>`;
const source = document.querySelector<HTMLAnchorElement>("#source")!;
// Supply the future public source URL at build time. Keep an explicit placeholder.
const sourceUrl = (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_SOURCE_URL;
source.href = sourceUrl || "#source-pending";
document.querySelector("#source-note")!.textContent = sourceUrl ? "Engine and client source" : "Repository URL pending publication";
const main = document.querySelector("main")!;
const client = new ProtocolClient(location.origin);
const lobby = new Lobby(client);
const owned = new Set<string>(JSON.parse(localStorage.getItem("doom-owned") || "[]"));
const own = (id: string) => { owned.add(id); localStorage.setItem("doom-owned", JSON.stringify([...owned])); };
let dispose: () => Promise<void> = async () => {};
let actionBusy = false;
function report(error: unknown) { document.querySelector("#error")!.textContent = String(error instanceof Error ? error.message : error); }
async function action(work: () => Promise<void>) {
  if (actionBusy) return;
  actionBusy = true; document.querySelector("#error")!.textContent = "";
  try { await work(); } catch (error) { report(error); }
  finally { actionBusy = false; }
}
const button = (id: string, work: () => Promise<void>) => document.getElementById(id)!.addEventListener("click", () => void action(work));
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) { const node = document.createElement(tag); node.textContent = text; return node; }
let assets: Promise<{ wad: Uint8Array; wasmBinary: Uint8Array; runtime: typeof import("../../engine/src/engine.js") }> | undefined;
async function engine(settings: { skill: number; episode?: number; map?: number }): Promise<Engine> {
  assets ??= (async () => {
    const bytes = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error(`Engine asset ${url}: ${response.status}`); return new Uint8Array(await response.arrayBuffer()); };
    const runtimeUrl = "/engine/src/engine.js";
    const [wad, wasmBinary, runtime] = await Promise.all([loadWad(), bytes("/engine/build/doom.wasm"), import(/* @vite-ignore */ runtimeUrl)]);
    return { wad, wasmBinary, runtime };
  })();
  const { wad, wasmBinary, runtime } = await assets;
  return runtime.createEngine(wad, { ...settings, wasmBinary });
}
function paint(game: Engine) {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(game.render()), 320, 200), 0, 0);
}
function stage(title: string, row: SessionMetadata, controls: string) {
  main.innerHTML = `<div class="toolbar"><h2 id="heading"></h2><button id="leave">Lobby</button></div><p id="session"></p><div class="stage"><canvas width="320" height="200" tabindex="0" aria-label="Doom game; click to focus keyboard"></canvas></div><div class="metrics" aria-live="off" id="metrics"></div><p class="score-hud" id="score-hud"></p>${controls}`;
  document.querySelector("#heading")!.textContent = title;
  document.querySelector("#session")!.textContent = `${row.playerName} · Skill ${row.skill} · ${row.id}${row.forkedFrom ? ` · Fork of ${row.forkedFrom} at tic ${row.forkTic}` : ""}`;
  button("leave", showLobby);
}

async function showLobby() {
  await dispose(); dispose = async () => {};
  history.replaceState(null, "", location.pathname);
  main.innerHTML = `<section><h2>Start a new timeline</h2><p>Play, watch live, or rewind and take the game in another direction.</p><form><label>Player name<input id="name" maxlength="40" value="Player" required></label><label>Skill<select id="skill"><option value="1">1 · I'm too young to die</option><option value="2">2 · Hey, not too rough</option><option value="3" selected>3 · Hurt me plenty</option><option value="4">4 · Ultra-Violence</option><option value="5">5 · Nightmare!</option></select></label><button class="primary">New game</button></form></section><section><h2>Sessions <span id="count"></span></h2><p id="transport">Connecting…</p><div id="sessions">Loading lobby…</div><p class="hint">Scores publish on stat changes or every five seconds of play. ¹Age is time since this tab received the score at its projected tic; initial history has no server timestamp. Watch shows lag in tics. New tabs replay retained lobby history.</p></section>`;
  document.querySelector("form")!.addEventListener("submit", event => {
    event.preventDefault();
    void action(async () => {
      const playerName = document.querySelector<HTMLInputElement>("#name")!.value.trim() || "Player";
      const skill = Number(document.querySelector<HTMLSelectElement>("#skill")!.value);
      document.querySelector<HTMLButtonElement>("form button")!.disabled = true;
      try {
        const game = await engine({ skill });
        const writer = await createSession(client, { playerName, identity: game.identity });
        own(writer.row.id); await play(game, writer);
      } finally { const submit = document.querySelector<HTMLButtonElement>("form button"); if (submit) submit.disabled = false; }
    });
  });
  const abort = new AbortController();
  dispose = async () => { abort.abort(); };
  const sessions = new StateRows<SessionMetadata>("session"), scores = new StateRows<StatsRow>("stats");
  const transports = new Map<string, string>();
  const received = new Map<string, number>();
  const render = () => {
    if (abort.signal.aborted) return;
    renderRows([...sessions.rows.values()], scores.rows, received);
  };
  void (async () => {
    await lobby.init();
    if (abort.signal.aborted) return;
    await Promise.all([
      followJson<StateEvent<SessionMetadata>>(client, "doom/v2/lobby", { signal: abort.signal, onBatch: events => { sessions.apply(events); render(); }, onTransport: mode => transport("Sessions", mode) }),
      followJson<StateEvent<StatsRow>>(client, "doom/v2/scores", { signal: abort.signal, onBatch: events => { scores.apply(events); for (const event of events) if (event.key) received.set(event.key, Date.now()); render(); }, onTransport: mode => transport("Scores", mode) }),
    ]);
  })().catch(error => { if (!abort.signal.aborted) report(error); });
  const ageTimer = setInterval(() => {
    for (const node of document.querySelectorAll<HTMLElement>("[data-score-received]")) {
      node.textContent = `Seen ${Math.floor((Date.now() - Number(node.dataset.scoreReceived)) / 1000)}s ago · tic ${node.dataset.scoreTic}`;
    }
  }, 1000);
  dispose = async () => { abort.abort(); clearInterval(ageTimer); };
  function transport(stream: string, mode: string) {
    if (abort.signal.aborted) return;
    transports.set(stream, mode);
    document.querySelector("#transport")!.textContent = [...transports].map(([name, mode]) => `${name}: ${mode}`).join(" · ");
  }
}
function scoreCells(score?: StatsRow) {
  return [score ? `E${score.episode}M${score.map}` : "—", ...[score?.health, score?.armor, score?.kills, score?.deaths].map(value => value === undefined ? "—" : String(value))];
}
function verification(score?: StatsRow) { return !score ? "Pending" : score.verified ? "Verified" : "Drift · unverified"; }
function renderRows(rows: SessionMetadata[], scores: ReadonlyMap<string, StatsRow>, received = new Map<string, number>()) {
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const container = document.querySelector("#sessions")!; container.replaceChildren();
  document.querySelector("#count")!.textContent = `(${rows.length})`;
  if (!rows.length) { container.append(el("p", "No sessions yet. Start the first game.")); return; }
  const table = document.createElement("table"), head = document.createElement("tr");
  for (const label of ["Player / timeline", "Map", "Health", "Armor", "Kills", "Deaths", "Verification", "Live", "Projection age¹", "Actions"]) head.append(el("th", label));
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr"), name = document.createElement("td"), score = scores.get(row.id);
    tr.dataset.id = row.id;
    name.append(el("strong", row.playerName), el("br", ""), el("code", row.id.slice(33, 41)));
    if (row.forkedFrom) name.append(el("p", `Forked at ${row.forkTic}`));
    tr.append(name);
    for (const text of scoreCells(score)) tr.append(el("td", text));
    const badge = el("td", verification(score)); badge.className = !score ? "pending" : score.verified ? "verified" : "unverified";
    const age = el("td", "Awaiting replay");
    if (score) {
      age.dataset.scoreReceived = String(received.get(row.id) ?? Date.now()); age.dataset.scoreTic = String(score.updatedTic);
      age.textContent = `Seen ${Math.floor((Date.now() - Number(age.dataset.scoreReceived)) / 1000)}s ago · tic ${score.updatedTic}`;
    }
    tr.append(badge, el("td", row.ended ? "Ended" : score?.live ? "● Live" : score ? "○ Idle" : "Pending"), age);
    const controls = document.createElement("td"), watchButton = el("button", "Watch");
    watchButton.addEventListener("click", () => void action(() => watch(row.id))); controls.append(watchButton);
    if (owned.has(row.id)) {
      const remove = el("button", "Delete");
      remove.addEventListener("click", () => void action(async () => { remove.disabled = true; try { await deleteSession(client, row.id); } finally { remove.disabled = false; } })); controls.append(remove);
    }
    tr.append(controls); table.append(tr);
  }
  container.append(table);
}

async function play(game: Engine, writer: SessionWriter) {
  await dispose();
  stage("Playing", writer.row, `<p>Click the game to focus. W/S move forward/back · A/D turn left/right · Space fires · Enter uses/interacts. Arrows also move/turn · Ctrl also fires · Alt strafes · Shift runs · Comma/Period strafe · 1–7 selects a weapon. Blur pauses local play and releases keys.</p><button id="end">End game & return to lobby</button>`);
  history.replaceState(null, "", `#watch/${writer.row.id}`);
  const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
  const store = new SnapshotStore(client, writer.row.id);
  let snapshotTic = (await store.entries()).at(-1)?.tic ?? 0, stopped = false, raf = 0;
  const queue = new FrameQueue(async frames => { await writer.append(frames); });
  const pollSnapshots = window.setInterval(() => {
    void store.entries().then(entries => { snapshotTic = entries.at(-1)?.tic ?? 0; }).catch(fail);
  }, 5000);
  const clock = new FixedStep();
  const { runtime } = await assets!;
  const keyboard = new KeyboardControls(runtime.keys, (code, down) => game.key(code, down));
  const release = () => { keyboard.release(); clock.pause(); };
  release();
  const key = (event: KeyboardEvent) => keyboard.handle(event, document.activeElement === canvas);
  window.addEventListener("keydown", key); window.addEventListener("keyup", key);
  window.addEventListener("blur", release); canvas.addEventListener("blur", release);
  const tick = (now: number) => {
    if (stopped) return;
    try {
      if (document.hasFocus()) clock.advance(now, () => { const frame = game.step(); queue.push(frame); });
      else clock.pause();
      // About five tics per batch, while the drain coalesces work behind slow writes.
      if (queue.pending >= 5) void queue.flush().catch(fail);
      if (queue.error) throw queue.error;
      paint(game);
      document.querySelector("#metrics")!.textContent = `Tic ${game.tic} · Pending frames ${queue.pending} · Batch ${queue.latency.toFixed(1)} ms · Snapshot ${snapshotTic || `pending at ${SNAPSHOT_INTERVAL}`}`;
      raf = requestAnimationFrame(tick);
    } catch (error) { fail(error); }
  };
  const fail = (error: unknown) => { stopped = true; cancelAnimationFrame(raf); clearInterval(pollSnapshots); release(); report(error); };
  dispose = async () => {
    stopped = true; cancelAnimationFrame(raf); clearInterval(pollSnapshots); release();
    window.removeEventListener("keydown", key); window.removeEventListener("keyup", key); window.removeEventListener("blur", release); canvas.removeEventListener("blur", release);
    await queue.flush(); await writer.end();
  };
  button("end", showLobby); canvas.focus(); paint(game); raf = requestAnimationFrame(tick);
}

async function watch(id: string) {
  await dispose(); dispose = async () => {};
  const row = await lobby.get(id);
  const reader = await new SessionReader(client, id).catchUp();
  if (!reader.header) throw new Error("Missing engine settings");
  let game = await engine(reader.header);
  const initial = await reader.seek(game, reader.frames.length);
  stage("Watching", row, `<label class="scrub">Timeline — release to seek<input id="scrub" type="range" min="0" max="0" value="0" step="1"></label><div class="toolbar"><button id="live" class="primary">Follow live</button><button id="fork">Fork here</button><span id="seek-info"></span></div>`);
  history.replaceState(null, "", `#watch/${id}`);
  const scrub = document.querySelector<HTMLInputElement>("#scrub")!, fork = document.querySelector<HTMLButtonElement>("#fork")!;
  const info = document.querySelector("#seek-info")!;
  let following = true, seeking = false, stopped = false, raf = 0;
  info.textContent = `Snapshot ${initial.snapshotTic} → tic ${game.tic}`;
  const abort = new AbortController();
  const scores = new StateRows<StatsRow>("stats");
  const hud = document.querySelector("#score-hud")!;
  hud.textContent = "Server replay: awaiting stats…";
  void followJson<StateEvent<StatsRow>>(client, "doom/v2/scores", { signal: abort.signal, onBatch: events => { scores.apply(events); } }).catch(error => { if (!abort.signal.aborted) report(error); });
  dispose = async () => { stopped = true; abort.abort(); cancelAnimationFrame(raf); };
  void (async () => { for await (const _ of reader.follow(abort.signal)) { /* reader retains the live frames; paint loop replays them */ } })().catch(error => { if (!abort.signal.aborted) { following = false; report(error); } });
  const tick = () => {
    if (stopped) return;
    try {
      if (following && !seeking) for (let n = 0; game.tic < reader.frames.length && n < 140; n++) game.step(reader.frames[game.tic]);
      if (!seeking) paint(game);
      const score = scores.rows.get(id);
      hud.textContent = score ? `Server replay · E${score.episode}M${score.map} · Health ${score.health} · Armor ${score.armor} · Kills ${score.kills} · Deaths ${score.deaths} · ${verification(score)} · ${score.live ? "Live" : "Idle"} · Projected ${score.tic} · Lag ${Math.max(0, reader.frames.length - score.tic)} tics (updated ${score.updatedTic})` : "Server replay: awaiting stats…";
      scrub.max = String(reader.frames.length);
      if (following) scrub.value = String(game.tic);
      document.querySelector("#metrics")!.textContent = `Tic ${game.tic} / ${reader.frames.length} · Live lag ${reader.frames.length - game.tic} tics · ${following ? "Following live" : "Scrubbed"}`;
      raf = requestAnimationFrame(tick);
    } catch (error) { following = false; report(error); }
  };
  scrub.addEventListener("input", () => { following = false; });
  scrub.addEventListener("change", () => void action(async () => {
    following = false; seeking = true; fork.disabled = true; scrub.disabled = true;
    try {
      // A separate reader avoids concurrent pull/seek on the live reader. Always
      // start fresh so seeking before the earliest checkpoint is safe.
      const fresh = await engine(reader.header!);
      const result = await new SessionReader(client, id).seek(fresh, Number(scrub.value));
      game = fresh; paint(game); info.textContent = `Snapshot ${result.snapshotTic} → tic ${game.tic}`;
    } finally { seeking = false; fork.disabled = false; scrub.disabled = false; }
  }));
  button("live", async () => { following = true; });
  button("fork", async () => {
    following = false; fork.disabled = true;
    try {
      const tic = game.tic;
      // Reconstruct on a fresh instance, including exact snapshot state, before
      // creating the child. Release captured parent keys when play begins.
      const fresh = await engine(reader.header!);
      await new SessionReader(client, id).seek(fresh, tic);
      const child = await forkSession(client, id, tic, { playerName: `${row.playerName} (fork)` });
      own(child.row.id); await play(fresh, child);
    } finally { fork.disabled = false; }
  });
  paint(game); raf = requestAnimationFrame(tick);
}
window.addEventListener("beforeunload", event => {
  // Async network drains cannot be guaranteed during unload. Use the End button.
  if (document.querySelector("#end")) { event.preventDefault(); event.returnValue = ""; }
});
async function openRoute() {
  const id = location.hash.match(/^#watch\/([a-zA-Z0-9_-]+)$/)?.[1];
  if (id) await watch(id); else await showLobby();
}
window.addEventListener("hashchange", () => void action(openRoute));
void action(openRoute);

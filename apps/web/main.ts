// SPDX-License-Identifier: GPL-2.0-or-later
import { Lobby, ProtocolClient, SessionReader, SnapshotStore, createSession, deleteSession, forkSession, type SessionRow, type SessionWriter, type Checkpoint } from "../../src/streams";
import type { Engine } from "../../engine/src/engine.js";
import { FixedStep, FrameQueue, Throttle } from "./timing";
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
function stage(title: string, row: SessionRow, controls: string) {
  main.innerHTML = `<div class="toolbar"><h2 id="heading"></h2><button id="leave">Lobby</button></div><p id="session"></p><div class="stage"><canvas width="320" height="200" tabindex="0" aria-label="Doom game; click to focus keyboard"></canvas></div><div class="metrics" aria-live="off" id="metrics"></div>${controls}`;
  document.querySelector("#heading")!.textContent = title;
  document.querySelector("#session")!.textContent = `${row.playerName} · Skill ${row.skill} · ${row.id}${row.forkedFrom ? ` · Fork of ${row.forkedFrom} at tic ${row.forkTic}` : ""}`;
  button("leave", showLobby);
}

async function showLobby() {
  await dispose(); dispose = async () => {};
  history.replaceState(null, "", location.pathname);
  main.innerHTML = `<section><h2>Start a new timeline</h2><p>Play, watch live, or rewind and take the game in another direction.</p><form><label>Player name<input id="name" maxlength="40" value="Player" required></label><label>Skill<select id="skill"><option value="1">1 · I'm too young to die</option><option value="2">2 · Hey, not too rough</option><option value="3" selected>3 · Hurt me plenty</option><option value="4">4 · Ultra-Violence</option><option value="5">5 · Nightmare!</option></select></label><button class="primary">New game</button></form></section><section><h2>Sessions <span id="count"></span></h2><div id="sessions">Loading lobby…</div></section>`;
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
  // Fold live rows from their real next offset; never re-read a cached lobby head.
  void (async () => {
    await lobby.init();
    let offset = "-1", cursor: string | undefined, live = false;
    const rows = new Map<string, SessionRow>();
    while (!abort.signal.aborted) {
      const batch = await client.read("doom/lobby", offset, live, abort.signal, cursor);
      if (abort.signal.aborted) break;
      for (const row of JSON.parse(new TextDecoder().decode(batch.bytes) || "[]") as SessionRow[]) rows.set(row.id, row);
      offset = batch.offset; cursor = batch.cursor; live = batch.upToDate;
      renderRows([...rows.values()].filter(row => row.status !== "deleted").reverse());
    }
  })().catch(error => { if (!abort.signal.aborted) report(error); });
}
function renderRows(rows: SessionRow[]) {
  const container = document.querySelector("#sessions")!; container.replaceChildren();
  document.querySelector("#count")!.textContent = `(${rows.length})`;
  if (!rows.length) { container.append(el("p", "No sessions yet. Start the first game.")); return; }
  const table = document.createElement("table"), head = document.createElement("tr");
  for (const label of ["Player / timeline", "Status", "Tics", "Actions"]) head.append(el("th", label));
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr"), name = document.createElement("td");
    name.append(el("strong", row.playerName), el("br", ""), el("code", row.id.slice(0, 8)));
    if (row.forkedFrom) name.append(el("p", `Forked from ${row.forkedFrom.slice(0, 8)} at ${row.forkTic}`));
    tr.append(name, el("td", row.status), el("td", String(row.tickCount)));
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
  const store = new SnapshotStore(client, writer.row.id), throttle = new Throttle();
  let snapshotTic = (await store.entries()).at(-1)?.tic ?? 0, stopped = false, raf = 0;
  const queue = new FrameQueue<Checkpoint>(async (frames, checkpoints) => {
    await writer.append(frames, { publishLobby: false });
    for (const checkpoint of checkpoints) { await store.write(checkpoint); snapshotTic = checkpoint.tic; }
    if (throttle.due(performance.now())) await lobby.put(writer.row);
  });
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
      if (document.hasFocus()) clock.advance(now, () => { const frame = game.step(); queue.push(frame, game.tic % writer.snapshotInterval === 0 ? game.snapshot() : undefined); });
      else clock.pause();
      // About five tics per batch, while the drain coalesces work behind slow writes.
      if (queue.pending >= 5) void queue.flush().catch(fail);
      if (queue.error) throw queue.error;
      paint(game);
      document.querySelector("#metrics")!.textContent = `Tic ${game.tic} · Pending frames ${queue.pending} · Batch ${queue.latency.toFixed(1)} ms · Snapshot ${snapshotTic || `pending at ${writer.snapshotInterval}`}`;
      raf = requestAnimationFrame(tick);
    } catch (error) { fail(error); }
  };
  const fail = (error: unknown) => { stopped = true; cancelAnimationFrame(raf); release(); report(error); };
  dispose = async () => {
    stopped = true; cancelAnimationFrame(raf); release();
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
  dispose = async () => { stopped = true; abort.abort(); cancelAnimationFrame(raf); };
  void (async () => { for await (const _ of reader.follow(abort.signal)) { /* reader retains the live frames; paint loop replays them */ } })().catch(error => { if (!abort.signal.aborted) { following = false; report(error); } });
  const tick = () => {
    if (stopped) return;
    try {
      if (following && !seeking) for (let n = 0; game.tic < reader.frames.length && n < 140; n++) game.step(reader.frames[game.tic]);
      if (!seeking) paint(game);
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

// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, ProtocolError, SessionReader, createSession, forkSession, deleteSession,
  sessionPath, batchPath, newSessionId, newForkId, followJson, followState, type SessionWriter, type StateEvent, type FollowOptions } from "../../src/streams";
import { StateRows } from "../../src/streams/state";
import type { StatsRow, EntryRow, PresenceRow, GameEvent } from "../../src/streams/v2";
import { serverEngine } from "../../apps/host-bun/engine";
import type { Recording } from "./recording";
export const scenarios = ["families", "siblings", "lineage", "cold", "lobby"] as const;
export type Scenario = typeof scenarios[number];
export interface Options {
  target: string; scenario: Scenario; players: number; tics: number; depth: number; idleMs: number;
  histories: number[]; followers: number; realtime: boolean; timeoutMs: number; scoreTimeoutMs: number;
  websocket?: boolean; signal?: AbortSignal;
  // Only local tests inject deterministic engine eviction / process restart.
  coldReset?: (ids: string[]) => Promise<void>;
  journal?: (result: Result) => Promise<void>;
}
export interface Append { id: string; startTic: number; endTic: number; sentAt: number; ackAt?: number; doneAt?: number }
export interface Observation { follower: number; id: string; tic: number; live: boolean; verified: boolean; at: number }
export interface Result {
  version: 1; run: string; options: Omit<Options, "coldReset" | "journal" | "signal">; startedAt: string; endedAt?: string;
  outcome: "running" | "passed" | "failed"; failure?: string; cleanupResumedAt?: string; ids: string[]; cleaned: string[];
  requests: { method: string; path: string; status: number; startedAt: number; ms: number }[];
  errors: { method: string; path: string; status: number; body: string }[];
  creates: { id: string; parent?: string; depth: number; ms: number }[];
  appends: Append[]; observations: Observation[]; lobbyObservations: Observation[]; lobbyStaleness: { id: string; head: number; entryTic: number; tics: number; ms?: number }[]; transports: { follower: number; mode: string; at: number }[];
  cold: { id: string; history: number; idleMs: number; reset: string; appendToScoreMs: number }[];
  replay?: { id: string; tics: number; readMs: number; localReplayMs: number; verified: boolean };
  activeWindow?: { start: number; end: number }; summary?: ReturnType<typeof summarize>;
}
export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { n: sorted.length, p50: at(.50), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
}
export function validate(options: Options) {
  if (!scenarios.includes(options.scenario)) throw new Error("Unknown scenario");
  for (const [key, min, max] of [["players", 1, 50], ["tics", 1, 21000], ["depth", 1, 49], ["followers", 1, 5],
    ["idleMs", 0, 600000], ["timeoutMs", 1, 810000], ["scoreTimeoutMs", 1, 60000]] as const) {
    const value = options[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}: ${value}`);
  }
  if (options.scenario === "siblings" && options.players > 49) throw new Error("Siblings include a parent: maximum 49 children");
  if (!options.histories.length || options.histories.length > 50 || options.histories.some(n => !Number.isInteger(n) || n < 1 || n > 21000)) throw new Error("Invalid cold histories");
  const u = new URL(options.target);
  if (u.pathname !== "/" || !["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Target must be an HTTP origin");
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
  const abort = () => { done(); reject(signal.reason); };
  const timer = setTimeout(done, Math.max(0, ms));
  signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
});
export function summarize(result: Result) {
  const primary = result.observations.filter(row => row.follower === 0);
  const pair = (rows: Observation[]) => rows.flatMap(row => {
    const batch = result.appends.find(b => b.id === row.id && row.tic > b.startTic && row.tic <= b.endTic && b.ackAt !== undefined);
    return batch ? [{ send: row.at - batch.sentAt, ack: row.at - batch.ackAt!,
      lower: Math.max(0, row.at - batch.ackAt!), upper: row.at - batch.sentAt }] : [];
  });
  const paired = pair(primary.filter(row => row.live));
  const idlePaired = pair(primary.filter(row => !row.live));
  const window = result.activeWindow;
  const activeRows = window ? primary.filter(row => row.at >= window.start && row.at <= window.end).length : 0;
  const byError: Record<string, number> = {};
  for (const e of result.errors) { const key = `${e.status} ${e.body}`; byError[key] = (byError[key] ?? 0) + 1; }
  return { measured: {
    bootstrapMs: percentiles(result.requests.filter(r => r.path.startsWith("/doom/v2/bootstrap/")).map(r => r.ms)),
    createMs: percentiles(result.creates.map(r => r.ms)),
    framePostRttMs: percentiles(result.requests.filter(r => r.method === "POST" && r.path.startsWith("/doom/v2/sessions/")).map(r => r.ms)),
    appendWithManifestMs: percentiles(result.appends.flatMap(r => r.doneAt === undefined ? [] : [r.doneAt - r.sentAt])),
    idleSendToScoreMs: percentiles(idlePaired.map(r => r.send)),
    hudLatencyMs: percentiles(paired.map(r => r.send)),
    lobbyDeliveryMs: percentiles(pair((result.lobbyObservations ?? []).filter(row => row.live)).map(r => r.send)),
    lobbyStalenessTics: percentiles((result.lobbyStaleness ?? []).map(r => r.tics)),
    lobbyStalenessMs: percentiles((result.lobbyStaleness ?? []).flatMap(r => r.ms === undefined ? [] : [r.ms])),
    sendToScoreMs: percentiles(paired.map(r => r.send)), ackToScoreMs: percentiles(paired.map(r => r.ack)),
    commitToObservedLowerMs: percentiles(paired.map(r => r.lower)), commitToObservedUpperMs: percentiles(paired.map(r => r.upper)),
    activeScoreRows: activeRows, activeSeconds: window ? (window.end - window.start) / 1000 : 0,
    scoreRowsPerSecond: window && window.end > window.start ? activeRows * 1000 / (window.end - window.start) : null,
    additionalFollowerDelayMs: percentiles(result.observations.filter(r => r.follower > 0).flatMap(r => {
      const first = primary.find(p => p.id === r.id && p.tic === r.tic && p.live === r.live);
      return first ? [r.at - first.at] : [];
    })), errors: byError, cleaned: result.cleaned.length, createdOrAttempted: result.ids.length,
  }, notMeasured: ["individual alarm hop latency", "server commit timestamp", "hosted CPU", "hosted memory", "confirmed hosted object eviction"],
    method: "Client wall-clock milliseconds. Actual frame commit occurs between send and acknowledgement: score receipt minus those endpoints bounds commit-to-client-observation latency. HUD latency follows each Game. Lobby delivery pairs Leaderboard arrival with its tic; lobby staleness samples the latest Leaderboard tic after every append, in tics and age since sending that tic’s batch (when known), including the intentional 175-tic cap. Includes alarms and delivery/network; sparse qualifying live rows only, with idle publications reported separately. Percentile bounds are not exact server latency. Score rows/s counts unique rows, not sink HTTP POSTs. Historical inherited rows excluded from lag pairing." };
}
/** Cleanup is restricted to journaled IDs generated by this invocation, including partial creates. */
export async function cleanup(client: ProtocolClient, ids: string[], cleaned: string[]) {
  const errors: unknown[] = [];
  for (const id of [...ids].reverse()) {
    if (cleaned.includes(id)) continue;
    try {
      try { await deleteSession(client, id); }
      catch {
        // A create may fail before the metadata row exists. Still remove only our known paths.
        await client.request(`doom/v2/delete/${id}`, { method: "POST" }).catch(error => {
          if (!(error instanceof ProtocolError && [404, 409].includes(error.status))) throw error;
        });
        await client.remove(batchPath(id));
      }
      // After browser cleanup, remove our frame stream too (children first).
      // Server-owned wakes/scores are publicly read-only and expire independently.
      await client.remove(sessionPath(id));
      cleaned.push(id);
    } catch (error) { errors.push(new Error(`Cleanup ${id}: ${String(error)}`)); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
}
export async function runScenario(options: Options, recording: Recording): Promise<Result> {
  validate(options);
  const run = `load-${options.scenario}-${crypto.randomUUID()}`;
  const { coldReset, journal, signal: external, ...wireOptions } = options;
  const result: Result = { version: 1, run, options: wireOptions, startedAt: new Date().toISOString(), outcome: "running", ids: [], cleaned: [],
    requests: [], errors: [], creates: [], appends: [], observations: [], lobbyObservations: [], lobbyStaleness: [], transports: [], cold: [] };
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(options.timeoutMs), ...(external ? [external] : [])]);
  const client = new ProtocolClient(options.target, async (input, init) => {
    const start = Date.now(), url = new URL(String(input)), method = init?.method ?? "GET";
    let response: Response;
    try { response = await fetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(url.searchParams.get("live") === "long-poll" ? 35000 : 15000)]) }); }
    catch (error) {
      if (!init?.signal?.aborted && !signal.aborted) result.errors.push({ method, path: url.pathname, status: 0, body: String(error) });
      throw error;
    }
    result.requests.push({ method, path: url.pathname, status: response.status, startedAt: start, ms: Date.now() - start });
    if (!response.ok && !(response.status === 404 && url.pathname.startsWith("/doom/v2/games/") || response.status === 404 && url.pathname === "/doom/v2/entries")) result.errors.push({ method, path: url.pathname, status: response.status, body: (await response.clone().text()).slice(0, 4096) });
    if (method === "POST" && url.pathname.startsWith("/doom/v2/sessions/") && response.ok) {
      const append = result.appends.findLast(a => a.id === url.pathname.split("/").at(-1) && a.ackAt === undefined);
      if (append) append.ackAt = Date.now();
    }
    return response;
  });
  const followAbort = new AbortController(), tasks: Promise<void>[] = [];
  const lobbyHeads = new Map<string, number>();
  const latest = new Map<string, StatsRow & { live: boolean }>(), seen = new Set<string>();
  let followFailure: unknown;
  const remember = async (id: string) => { result.ids.push(id); await journal?.(result); };
  const create = async () => {
    const id = newSessionId(); await remember(id); const start = Date.now();
    const writer = await createSession(client, { id, playerName: `${run.slice(0, 32)}-${result.ids.length}`, identity: recording.identity });
    followGame(id);
    result.creates.push({ id, depth: 0, ms: Date.now() - start }); return writer;
  };
  const fork = async (parent: SessionWriter, tic: number, depth: number) => {
    const id = newForkId(parent.row.id); await remember(id); const start = Date.now();
    const writer = await forkSession(client, parent.row.id, tic, { id, playerName: `${run.slice(0, 32)}-${result.ids.length}` });
    followGame(id);
    result.creates.push({ id, parent: parent.row.id, depth, ms: Date.now() - start }); return writer;
  };
  const append = async (writer: SessionWriter, n: number) => {
    signal.throwIfAborted(); if (followFailure) throw followFailure;
    const startTic = writer.tic, endTic = startTic + n;
    if (endTic > recording.frames.length) throw new Error("Recording too short");
    const row: Append = { id: writer.row.id, startTic, endTic, sentAt: Date.now() }; result.appends.push(row);
    await writer.append(recording.frames.slice(startTic, endTic)); row.doneAt = Date.now();
    const entryTic = lobbyHeads.get(writer.row.id);
    if (entryTic !== undefined) {
      const source = result.appends.find(b => b.id === writer.row.id && entryTic > b.startTic && entryTic <= b.endTic);
      result.lobbyStaleness.push({ id: writer.row.id, head: writer.tic, entryTic, tics: Math.max(0, writer.tic - entryTic), ms: source ? Date.now() - source.sentAt : undefined });
    }
  };
  const play = async (writer: SessionWriter, n: number) => {
    const start = Date.now(); let sent = 0;
    while (sent < n) {
      const count = Math.min(5, n - sent);
      // Slow writes coalesce pending tics like the browser, capped to the remaining history.
      if (options.realtime) await pause(start + (sent + count) * 1000 / 35 - Date.now(), signal);
      const batch = options.realtime ? Math.min(n - sent, Math.max(count, Math.floor((Date.now() - start) * 35 / 1000) - sent)) : count;
      await append(writer, batch); sent += batch;
    }
  };
  const until = async (predicate: () => boolean, label: string, ms = options.scoreTimeoutMs) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (followFailure) throw followFailure;
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await pause(20, signal);
    }
  };
  const score = async (writer: SessionWriter) => {
    const expected = recording.publications.findLast(tic => tic <= writer.tic) ?? 0;
    await until(() => (latest.get(writer.row.id)?.tic ?? -1) >= expected, `score ${writer.row.id} >= ${expected}`);
    if (!latest.get(writer.row.id)?.verified) throw new Error(`Unverified synthetic score ${writer.row.id}`);
    await until(() => lobbyHeads.has(writer.row.id), `initial lobby summary ${writer.row.id}`);
  };
  const parallel = async <T>(jobs: (() => Promise<T>)[]) => {
    const pending = jobs.map(async job => { try { return await job(); } catch (e) { cancel.abort(e); throw e; } });
    const done = await Promise.allSettled(pending);
    const failed = done.find(r => r.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    return done.map(r => (r as PromiseFulfilledResult<T>).value);
  };
  const resilientFollow = async <T>(path: string, followOptions: FollowOptions<T>) => {
    for (let retry = 0; !followAbort.signal.aborted; retry++) {
      try {
        if (path === "doom/v2/leaderboard") await followState(client, { ...followOptions, stream: path, snapshot: "doom/v2/state-snapshot/leaderboard" });
        else await followJson(client, path, followOptions);
        return;
      }
      catch (error) {
        if (signal.aborted || followAbort.signal.aborted) return;
        result.errors.push({ method: "FOLLOW", path, status: 0, body: String(error) });
        if (retry >= 2) throw error;
        await pause(500, followAbort.signal).catch(() => {});
      }
    }
  };
  const failFollow = (error: unknown) => { if (!signal.aborted && !followAbort.signal.aborted) { followFailure = error; cancel.abort(error); } };
  const followGame = (id: string) => {
    for (let follower = 0; follower < options.followers; follower++) {
      const stats = new StateRows<StatsRow>("stats"), presence = new StateRows<PresenceRow>("presence");
      tasks.push(resilientFollow<GameEvent>(`doom/v2/games/${id}`, {
        signal: followAbort.signal, websocket: options.websocket,
        onTransport: mode => result.transports.push({ follower, mode, at: Date.now() }),
        onBatch: events => {
          stats.apply(events); presence.apply(events);
          const value = stats.rows.get(id); if (!value) return;
          const row = { ...value, live: presence.rows.get(id)?.live ?? true };
          const key = `${follower}:${id}:${row.tic}:${row.live}`;
          if (seen.has(key)) return; seen.add(key);
          result.observations.push({ follower, id, tic: row.tic, live: row.live, verified: row.verified, at: Date.now() });
          if (follower === 0) latest.set(id, row);
        },
      }).catch(failFollow));
    }
  };
  try {
    tasks.push(resilientFollow<StateEvent<EntryRow>>("doom/v2/leaderboard", {
      signal: followAbort.signal, websocket: options.websocket,
      onBatch: events => {
        for (const event of events) {
          const row = event.value;
          if (!row?.score || !row.id || !result.ids.includes(row.id)) continue;
          lobbyHeads.set(row.id, row.score.tic);
          result.lobbyObservations.push({ follower: 0, id: row.id, tic: row.score.tic, live: row.live ?? false, verified: row.score.verified, at: Date.now() });
        }
      },
    }).catch(failFollow));
    if (options.scenario === "families" || options.scenario === "lobby") {
      const writers = await parallel(Array.from({ length: options.players }, () => create));
      await parallel(writers.map(w => () => score(w)));
      result.activeWindow = { start: Date.now(), end: 0 };
      await parallel(writers.map(w => async () => { await play(w, options.tics); await score(w); }));
      result.activeWindow.end = Date.now();
    } else if (options.scenario === "siblings") {
      const parent = await create(); await append(parent, 12); await score(parent);
      const writers = await parallel(Array.from({ length: options.players }, () => () => fork(parent, 7, 1)));
      result.activeWindow = { start: Date.now(), end: 0 };
      await parallel(writers.map(w => async () => { await play(w, options.tics); await score(w); }));
      result.activeWindow.end = Date.now();
    } else if (options.scenario === "lineage") {
      let writer = await create(); await play(writer, options.tics);
      result.activeWindow = { start: Date.now(), end: 0 };
      for (let depth = 1; depth <= options.depth; depth++) { writer = await fork(writer, writer.tic, depth); await play(writer, 5); }
      await score(writer); result.activeWindow.end = Date.now();
      const start = Date.now(), reader = await new SessionReader(client, writer.row.id).catchUp(), readMs = Date.now() - start;
      const engine = await (await serverEngine())(recording.identity), began = Date.now();
      let verified = true; for (const frame of reader.frames) verified = engine.step(frame) && verified;
      result.replay = { id: writer.row.id, tics: reader.frames.length, readMs, localReplayMs: Date.now() - began, verified };
      if (!verified || reader.frames.length !== writer.tic) throw new Error("Deep lineage replay mismatch");
    } else {
      // Seed the full history at browser cadence, then allow replay owners to go idle.
      const writers = await parallel(options.histories.map(history => async () => {
        const writer = await create(); await play(writer, history); await score(writer); return writer;
      }));
      const idleStart = Date.now();
      await pause(options.idleMs, signal);
      if (coldReset) await coldReset(writers.map(w => w.row.id));
      else await until(() => writers.every(w => latest.get(w.row.id)?.live === false), "idle cache-release scores");
      for (const writer of writers) {
        const history = writer.tic, began = Date.now();
        await play(writer, 175); await score(writer);
        result.cold.push({ id: writer.row.id, history, idleMs: began - idleStart,
          reset: coldReset ? "local injected reset" : "idle engine release; object eviction unconfirmed", appendToScoreMs: Date.now() - began });
      }
    }
    // Ensure all extra lobby followers receive the primary follower's final observations.
    const tail = [...latest.values()];
    await until(() => tail.every(row => Array.from({ length: options.followers }, (_, i) => seen.has(`${i}:${row.id}:${row.tic}:${row.live}`)).every(Boolean)), "all lobby followers caught up");
    result.outcome = "passed";
  } catch (error) {
    result.outcome = "failed"; result.failure = String(error);
    result.errors.push({ method: "HARNESS", path: options.scenario, status: 0, body: String(error) });
  } finally {
    if (result.activeWindow && !result.activeWindow.end) result.activeWindow.end = Date.now();
    followAbort.abort(); await Promise.allSettled(tasks);
    // Fresh timeout permits cleanup even after workload cancellation/deadline.
    const cleanupDeadline = AbortSignal.timeout(60000);
    const cleanupClient = new ProtocolClient(options.target, async (input, init) => {
      const response = await fetch(input, { ...init, signal: AbortSignal.any([cleanupDeadline, AbortSignal.timeout(15000)]) });
      if (!response.ok && response.status !== 404) result.errors.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname,
        status: response.status, body: (await response.clone().text()).slice(0, 4096) });
      return response;
    });
    try { await cleanup(cleanupClient, result.ids, result.cleaned); }
    catch (error) { result.outcome = "failed"; result.errors.push({ method: "CLEANUP", path: options.scenario, status: 0, body: String(error) }); }
    result.endedAt = new Date().toISOString(); result.summary = summarize(result); await journal?.(result);
  }
  return result;
}

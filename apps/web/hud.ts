// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, StateRows, followJson } from "../../src/streams";
import type { StatsRow, PresenceRow, SessionMetadata, GameEvent } from "../../src/streams/v2";
/** Wall times are keyed by exact tic; wrapping never returns an older tic's time. */
export class TicClock {
  private readonly times = new Map<number, number>();
  constructor(readonly capacity = 2048) {}
  record(tic: number, now: number) {
    this.times.set(tic, now);
    while (this.times.size > this.capacity) this.times.delete(this.times.keys().next().value!);
  }
  timeOf(tic: number) { return this.times.get(tic); }
}
export class HudLatency {
  private samples: number[] = [];
  private arrivedAt?: number;
  private tic?: number;
  last?: { tics: number; ms?: number; median?: number; count: number };
  constructor(readonly clock?: TicClock) {}
  arrive(tic: number, head: number, now: number) {
    this.tic = tic; this.arrivedAt = head;
    const time = this.clock?.timeOf(tic);
    if (this.clock && time === undefined) { this.last = undefined; return; }
    if (time !== undefined) { this.samples.push(Math.max(0, now - time)); this.samples = this.samples.slice(-20); }
    const sorted = [...this.samples].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    this.last = { tics: Math.max(0, head - tic), ms: time === undefined ? undefined : Math.max(0, now - time), count: sorted.length,
      median: sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : undefined };
  }
  stalled(head: number) { return this.arrivedAt !== undefined && head - this.arrivedAt > 350; }
  text(head: number, watching = !this.clock) {
    if (this.tic === undefined) return "Server replay: awaiting stats…";
    if (this.stalled(head)) return `No stats for ${head - this.arrivedAt!} tics`;
    if (!this.last) return `Server replay catching up · tic ${this.tic} of ${head}`;
    if (watching) return `Head of game · tic ${this.tic} · ${this.last.tics} tics behind the frames in this tab`;
    return `Server replay · tic ${this.tic} · HUD latency ${this.last.tics} tics · ${Math.round(this.last.ms!)} ms (median of ${this.last.count}: ${Math.round(this.last.median!)} ms)`;
  }
}
export class GameHud {
  private readonly abort = new AbortController();
  private readonly stats = new StateRows<StatsRow>("stats");
  private readonly presence = new StateRows<PresenceRow>("presence");
  private readonly sessions = new StateRows<SessionMetadata>("session");
  readonly latency: HudLatency;
  private timer: ReturnType<typeof setInterval>;
  private status = "";
  constructor(readonly node: HTMLElement, client: ProtocolClient, readonly id: string,
    readonly options: { head: () => number; clock?: TicClock; onError: (error: unknown) => void }) {
    this.latency = new HudLatency(options.clock);
    this.render();
    void followJson<GameEvent>(client, `doom/v2/games/${id}`, { signal: this.abort.signal, onBatch: events => {
      this.stats.apply(events); this.presence.apply(events); this.sessions.apply(events);
      if (events.some(event => event.type === "stats" && event.value)) {
        const row = this.stats.rows.get(id);
        if (row) this.latency.arrive(row.tic, options.head(), performance.now());
      }
      this.render();
    } }).catch(error => { if (!this.abort.signal.aborted) options.onError(error); });
    // Detect stalls even when no stream event arrives, without repainting per frame.
    this.timer = setInterval(() => { if (this.status !== this.latency.text(options.head())) this.render(); }, 500);
  }
  dispose() { this.abort.abort(); clearInterval(this.timer); }
  private render() {
    const row = this.stats.rows.get(this.id), session = this.sessions.rows.get(this.id);
    this.node.replaceChildren(); this.node.className = "hud";
    if (row) {
      const cell = (label: string, value: string, title?: string) => {
        const node = document.createElement("div"), key = document.createElement("span"), text = document.createElement("strong");
        key.textContent = label; text.textContent = value; node.append(key, text); if (title) node.title = title; this.node.append(node);
      };
      cell("Map", `E${row.episode}M${row.map}`); cell("Health", String(row.health)); cell("Armor", String(row.armor));
      cell("Ammo", `${row.ammo} (wpn ${row.weapon})`);
      for (const [label, value, total, running] of [["Kills", row.levelKills, row.levelTotalKills, row.kills], ["Items", row.levelItems, row.levelTotalItems, row.items], ["Secrets", row.levelSecrets, row.levelTotalSecrets, row.secrets]] as const)
        cell(label, `${value}/${total}`, `Running total: ${running}`);
      cell("Deaths", String(row.deaths));
      cell(row.verified ? "Verified" : "Drift · unverified", session?.ended ? "Ended" : this.presence.rows.get(this.id)?.live ? "● Live" : "○ Idle");
    }
    this.status = this.latency.text(this.options.head());
    const status = document.createElement("p"); status.textContent = this.status;
    status.className = this.latency.stalled(this.options.head()) || row?.verified === false ? "unverified" : "";
    this.node.append(status);
  }
}

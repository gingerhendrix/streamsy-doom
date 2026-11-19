// SPDX-License-Identifier: GPL-2.0-or-later
import {
  followState,
  gameStatePath,
  gameStateSnapshotPath,
  StateRows,
  TICS_PER_SECOND,
  type ProtocolClient,
} from "../../src/streams";
import type {
  GameEvent,
  PresenceRow,
  SessionMetadata,
  StatsRow,
} from "../../src/streams/declarations";

const REMEMBERED_TICS = 2048;
const LATENCY_SAMPLES = 20;
const STALLED_AFTER_TICS = 10 * TICS_PER_SECOND;
const CHECK_FOR_STALL_EVERY_MS = 500;

const median = (sorted: number[]) => {
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export class TicClock {
  private readonly wallTimeOfTic = new Map<number, number>();

  constructor(readonly capacity = REMEMBERED_TICS) {}

  record(tic: number, now: number) {
    this.wallTimeOfTic.set(tic, now);
    while (this.wallTimeOfTic.size > this.capacity) this.forgetOldestTic();
  }

  private forgetOldestTic() {
    this.wallTimeOfTic.delete(this.wallTimeOfTic.keys().next().value!);
  }

  timeOf(tic: number) {
    return this.wallTimeOfTic.get(tic);
  }
}

export class HudLatency {
  private samples: number[] = [];
  private headWhenStatsArrived?: number;
  private statsTic?: number;
  last?: { tics: number; ms?: number; median?: number; count: number };

  constructor(readonly clock?: TicClock) {}

  arrive(tic: number, head: number, now: number) {
    this.statsTic = tic;
    this.headWhenStatsArrived = head;
    const steppedAt = this.clock?.timeOf(tic);
    const ticIsOlderThanTheClockRemembers = this.clock && steppedAt === undefined;
    if (ticIsOlderThanTheClockRemembers) {
      this.last = undefined;
      return;
    }
    const ms = steppedAt === undefined ? undefined : Math.max(0, now - steppedAt);
    if (ms !== undefined) this.samples = [...this.samples, ms].slice(-LATENCY_SAMPLES);
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.last = {
      tics: Math.max(0, head - tic),
      ms,
      count: sorted.length,
      median: median(sorted),
    };
  }

  private ticsSinceStatsArrived(head: number) {
    return this.headWhenStatsArrived === undefined ? 0 : head - this.headWhenStatsArrived;
  }

  stalled(head: number) {
    return this.ticsSinceStatsArrived(head) > STALLED_AFTER_TICS;
  }

  text(head: number, watching = !this.clock) {
    if (this.statsTic === undefined) return "Server replay: awaiting stats…";
    if (this.stalled(head)) return `No stats for ${this.ticsSinceStatsArrived(head)} tics`;
    if (!this.last) return `Server replay catching up · tic ${this.statsTic} of ${head}`;
    const { tics, ms, median, count } = this.last;
    if (watching)
      return `Head of game · tic ${this.statsTic} · ${tics} tics behind the frames in this tab`;
    return `Server replay · tic ${this.statsTic} · HUD latency ${tics} tics · ${Math.round(ms!)} ms (median of ${count}: ${Math.round(median!)} ms)`;
  }
}

export class GameHud {
  private readonly leaving = new AbortController();
  private readonly stats = new StateRows<StatsRow>("stats");
  private readonly presence = new StateRows<PresenceRow>("presence");
  private readonly sessions = new StateRows<SessionMetadata>("session");
  readonly latency: HudLatency;
  private readonly stallCheck: ReturnType<typeof setInterval>;
  private shownStatus = "";

  constructor(
    readonly node: HTMLElement,
    client: ProtocolClient,
    readonly id: string,
    readonly options: {
      head: () => number;
      clock?: TicClock;
      onError: (error: unknown) => void;
    },
  ) {
    this.latency = new HudLatency(options.clock);
    this.render();
    void followState<GameEvent>(client, {
      snapshot: gameStateSnapshotPath(id),
      stream: gameStatePath(id),
      signal: this.leaving.signal,
      onBatch: (events) => this.applyGameEvents(events),
    }).catch((error) => {
      if (!this.leaving.signal.aborted) options.onError(error);
    });
    this.stallCheck = setInterval(() => this.renderIfStatusChanged(), CHECK_FOR_STALL_EVERY_MS);
  }

  dispose() {
    this.leaving.abort();
    clearInterval(this.stallCheck);
  }

  private applyGameEvents(events: GameEvent[]) {
    this.stats.apply(events);
    this.presence.apply(events);
    this.sessions.apply(events);
    const statsArrived = events.some((event) => event.type === "stats" && event.value);
    const row = this.stats.rows.get(this.id);
    if (statsArrived && row) this.latency.arrive(row.tic, this.options.head(), performance.now());
    this.render();
  }

  private renderIfStatusChanged() {
    if (this.shownStatus !== this.latency.text(this.options.head())) this.render();
  }

  private livenessLabel() {
    if (this.sessions.rows.get(this.id)?.ended) return "Ended";
    return this.presence.rows.get(this.id)?.live ? "● Live" : "○ Idle";
  }

  private appendCell(label: string, value: string, tooltip?: string) {
    const cell = document.createElement("div");
    const labelNode = document.createElement("span");
    const valueNode = document.createElement("strong");
    labelNode.textContent = label;
    valueNode.textContent = value;
    cell.append(labelNode, valueNode);
    if (tooltip) cell.title = tooltip;
    this.node.append(cell);
  }

  private appendStatsCells(row: StatsRow) {
    this.appendCell("Map", `E${row.episode}M${row.map}`);
    this.appendCell("Health", String(row.health));
    this.appendCell("Armor", String(row.armor));
    this.appendCell("Ammo", `${row.ammo} (wpn ${row.weapon})`);
    const levelProgress = [
      ["Kills", row.levelKills, row.levelTotalKills, row.kills],
      ["Items", row.levelItems, row.levelTotalItems, row.items],
      ["Secrets", row.levelSecrets, row.levelTotalSecrets, row.secrets],
    ] as const;
    for (const [label, found, total, runningTotal] of levelProgress)
      this.appendCell(label, `${found}/${total}`, `Running total: ${runningTotal}`);
    this.appendCell("Deaths", String(row.deaths));
    this.appendCell(row.verified ? "Verified" : "Drift · unverified", this.livenessLabel());
  }

  private render() {
    const row = this.stats.rows.get(this.id);
    const head = this.options.head();
    this.node.replaceChildren();
    this.node.className = "hud";
    if (row) this.appendStatsCells(row);
    this.shownStatus = this.latency.text(head);
    const status = document.createElement("p");
    status.textContent = this.shownStatus;
    const needsAttention = this.latency.stalled(head) || row?.verified === false;
    status.className = needsAttention ? "unverified" : "";
    this.node.append(status);
  }
}

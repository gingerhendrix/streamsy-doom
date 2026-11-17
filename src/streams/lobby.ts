// SPDX-License-Identifier: GPL-2.0-or-later
import { isFamilyId } from "./ids";
import { ProtocolClient, ProtocolError } from "./protocol";
import { StateRows, type StateEvent } from "./state";
import type { SessionMetadata } from "./v2";
export interface SessionRow {
  id: string; playerName: string; skill: number; episode: number; map: number;
  createdAt: string; status: "playing" | "ended" | "deleted"; tickCount: number;
  forkedFrom: string | null; forkTic: number | null;
}
export class Lobby {
  constructor(readonly client: ProtocolClient) {}
  async init() {
    await this.client.create("doom/lobby", "[]", "application/json");
    await this.client.create("doom/v2/lobby", "[]", "application/json");
  }
  async put(row: SessionRow) {
    const v2 = isFamilyId(row.id);
    const { id, playerName, skill, episode, map, createdAt, forkedFrom, forkTic } = row;
    const value: SessionMetadata = { id, playerName, skill, episode, map, createdAt, forkedFrom, forkTic, ended: row.status === "ended" };
    const event = { type: "session", key: row.id, value, headers: { operation: "upsert" } };
    await this.client.append(v2 ? "doom/v2/lobby" : "doom/lobby", JSON.stringify([v2 ? event : row]), "application/json");
  }
  async delete(row: SessionRow) {
    if (!isFamilyId(row.id)) return this.put({ ...row, status: "deleted" });
    await this.client.append("doom/v2/lobby", JSON.stringify([{ type: "session", key: row.id, headers: { operation: "delete" } }]), "application/json");
  }
  private async events<T>(path: string): Promise<T[]> {
    try { return await this.client.json<T>(path); }
    catch (error) { if (error instanceof ProtocolError && error.status === 404) return []; throw error; }
  }
  async rows() {
    const rows = new Map<string, SessionRow>();
    for (const row of await this.events<SessionRow>("doom/lobby")) rows.set(row.id, row);
    const state = new StateRows<SessionMetadata>("session");
    state.apply(await this.events<StateEvent<SessionMetadata>>("doom/v2/lobby"));
    for (const row of state.rows.values()) rows.set(row.id, sessionRow(row));
    return [...rows.values()];
  }
  async get(id: string) {
    const row = (await this.rows()).find(row => row.id === id);
    if (!row) throw new Error(`Session missing from lobby: ${id}`);
    return row;
  }
}
// Writer tic counts stay local; the v2 wire row contains only session metadata.
export const sessionRow = (row: SessionMetadata): SessionRow => ({ ...row, status: row.ended ? "ended" : "playing", tickCount: row.forkTic ?? 0 });

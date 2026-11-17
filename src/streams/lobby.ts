// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient } from "./protocol";
export interface SessionRow {
  id: string; playerName: string; skill: number; episode: number; map: number;
  createdAt: string; status: "playing" | "ended" | "deleted"; tickCount: number;
  forkedFrom: string | null; forkTic: number | null;
}
export class Lobby {
  constructor(readonly client: ProtocolClient) {}
  async init() { await this.client.create("doom/lobby", "[]", "application/json"); }
  async put(row: SessionRow) {
    await this.client.append("doom/lobby", JSON.stringify([row]), "application/json");
  }
  async rows() {
    const rows = new Map<string, SessionRow>();
    for (const row of await this.client.json<SessionRow>("doom/lobby")) rows.set(row.id, row);
    return [...rows.values()];
  }
  async get(id: string) {
    const row = (await this.rows()).find(row => row.id === id);
    if (!row) throw new Error(`Session missing from lobby: ${id}`);
    return row;
  }
}

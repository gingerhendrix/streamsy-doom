// SPDX-License-Identifier: GPL-2.0-or-later
import { isFamilyId } from "./ids";
import { ProtocolClient, ProtocolError } from "./protocol";
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
    const event = { type: "session", key: row.id, value: row, headers: { operation: "upsert" } };
    await this.client.append(v2 ? "doom/v2/lobby" : "doom/lobby", JSON.stringify([v2 ? event : row]), "application/json");
  }
  private async events<T>(path: string): Promise<T[]> {
    try { return await this.client.json<T>(path); }
    catch (error) { if (error instanceof ProtocolError && error.status === 404) return []; throw error; }
  }
  async rows() {
    const rows = new Map<string, SessionRow>();
    for (const row of await this.events<SessionRow>("doom/lobby")) rows.set(row.id, row);
    for (const event of await this.events<{ key: string; value: SessionRow; headers: { operation: string } }>("doom/v2/lobby")) {
      if (event.headers.operation === "delete") rows.delete(event.key); else rows.set(event.key, event.value);
    }
    return [...rows.values()];
  }
  async get(id: string) {
    const row = (await this.rows()).find(row => row.id === id);
    if (!row) throw new Error(`Session missing from lobby: ${id}`);
    return row;
  }
}

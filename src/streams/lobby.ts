// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, ProtocolError, validId } from "./protocol";
import { StateRows, type StateEvent } from "./state";
import type { SessionMetadata } from "./v2";
export class Lobby {
  constructor(readonly client: ProtocolClient) {}
  async init() {
    await this.client.create("doom/v2/lobby", "[]", "application/json");
  }
  async put(row: SessionMetadata) {
    validId(row.id);
    const event = { type: "session", key: row.id, value: row, headers: { operation: "upsert" } };
    await this.client.append("doom/v2/lobby", JSON.stringify([event]), "application/json");
  }
  async delete(row: SessionMetadata) {
    validId(row.id);
    await this.client.append("doom/v2/lobby", JSON.stringify([{ type: "session", key: row.id, headers: { operation: "delete" } }]), "application/json");
  }
  async rows() {
    const state = new StateRows<SessionMetadata>("session");
    try { state.apply(await this.client.json<StateEvent<SessionMetadata>>("doom/v2/lobby")); }
    catch (error) { if (!(error instanceof ProtocolError && error.status === 404)) throw error; }
    return [...state.rows.values()];
  }
  async get(id: string) {
    validId(id);
    const row = (await this.rows()).find(row => row.id === id);
    if (!row) throw new Error(`Session missing from lobby: ${id}`);
    return row;
  }
}

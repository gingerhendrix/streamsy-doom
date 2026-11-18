// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, validId } from "./protocol";
import { StateRows } from "./state";
import type { SessionMetadata } from "./v2";
export class Lobby {
  constructor(readonly client: ProtocolClient) {}
  async rows() {
    const state = new StateRows<import("./v2").EntryRow>("game");
    state.apply(await (await this.client.request("doom/v2/state-snapshot/leaderboard")).json());
    return [...state.rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  async get(id: string) {
    validId(id);
    const state = new StateRows<SessionMetadata>("session");
    state.apply(await (await this.client.request(`doom/v2/state-snapshot/games/${id}`)).json());
    const row = state.rows.get(id);
    if (!row) throw new Error(`Session missing from game: ${id}`);
    return row;
  }
}

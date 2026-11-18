// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, ProtocolError, validId } from "./protocol";
import { StateRows, type StateEvent } from "./state";
import type { SessionMetadata } from "./v2";
export class Lobby {
  constructor(readonly client: ProtocolClient) {}
  async rows() {
    const state = new StateRows<import("./v2").EntryRow>("entry");
    try { state.apply(await this.client.json<StateEvent<import("./v2").EntryRow>>("doom/v2/entries")); }
    catch (error) { if (!(error instanceof ProtocolError && error.status === 404)) throw error; }
    return [...state.rows.values()];
  }
  async get(id: string) {
    validId(id);
    const state = new StateRows<SessionMetadata>("session");
    state.apply(await this.client.json<StateEvent<SessionMetadata>>(`doom/v2/games/${id}`));
    const row = state.rows.get(id);
    if (!row) throw new Error(`Session missing from game: ${id}`);
    return row;
  }
}

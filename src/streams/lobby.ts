// SPDX-License-Identifier: GPL-2.0-or-later
import type { EntryRow, SessionMetadata } from "./declarations";
import { recentFirst } from "./entry-order";
import { validSessionId } from "./ids";
import { gameStateSnapshotPath, leaderboardStateSnapshotPath } from "./paths";
import type { ProtocolClient } from "./protocol";
import { StateRows } from "./state";

export class Lobby {
  constructor(readonly client: ProtocolClient) {}

  private async rowsOfSnapshot<T extends object>(snapshotPath: string, collection: string) {
    const state = new StateRows<T>(collection);
    const snapshot = await this.client.request(snapshotPath);
    state.apply(await snapshot.json());
    return state.rows;
  }

  async rows() {
    const rows = await this.rowsOfSnapshot<EntryRow>(leaderboardStateSnapshotPath, "game");
    return [...rows.values()].sort(recentFirst);
  }

  async get(id: string) {
    validSessionId(id);
    const sessions = await this.rowsOfSnapshot<SessionMetadata>(
      gameStateSnapshotPath(id),
      "session",
    );
    const session = sessions.get(id);
    if (!session) throw new Error(`Session missing from game: ${id}`);
    return session;
  }
}

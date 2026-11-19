// SPDX-License-Identifier: GPL-2.0-or-later
import { Effect } from "effect";
import { Game, ReplayWake } from "../streams/declarations";
import { absoluteExpiry } from "../streams/expiry";

export const createReplayStreamsWithOneExpiry = (id: string) =>
  Effect.gen(function* () {
    const wake = yield* ReplayWake;
    const game = yield* Game;
    yield* wake
      .head({ id })
      .pipe(
        Effect.catchTag("StreamNotFound", () =>
          wake.create({ id }, { expiresAt: absoluteExpiry() }),
        ),
      );
    const expiresAt = (yield* wake.head({ id })).expiresAt!;
    yield* game
      .head({ id })
      .pipe(Effect.catchTag("StreamNotFound", () => game.create({ id }, { expiresAt })));
  });

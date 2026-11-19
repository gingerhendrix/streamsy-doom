// SPDX-License-Identifier: GPL-2.0-or-later
import type { DurableObjectState } from "@cloudflare/workers-types";
import { Http } from "@streamsy/core";
import { CheckpointStore, ProjectionWakeup } from "@streamsy/projection";
import { StreamsyObject } from "@streamsy/serve/cloudflare";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";
import { Layer } from "effect";
import { frameWake } from "../../src/projection/frame-wake";
import { LONG_POLL_TIMEOUT_MS, MAX_APPEND_BYTES } from "../../src/server/limits";
import { familyStreams, type ReplayWake } from "../../src/streams/declarations";
import type { Env } from "./env";
import { framesLink, wakeLink } from "./topology";

export const SIBLING_REPLAYS_WOKEN_CONCURRENTLY = 8;

const gamesLayer = (state: DurableObjectState) =>
  CheckpointStore.layer.pipe(
    Layer.provideMerge(
      DurableObjectStorage.layer(familyStreams, {
        client: { storage: state.storage },
        longPollTimeoutMs: LONG_POLL_TIMEOUT_MS,
      }),
    ),
  );

const publicFrameAndManifestStreams = Http.routes(familyStreams, {
  prefix: "/",
  access: "full",
  maxMessageSize: MAX_APPEND_BYTES,
});

export const gamesHost = (concurrency = SIBLING_REPLAYS_WOKEN_CONCURRENTLY) =>
  StreamsyObject.make<Env, Layer.Success<ReturnType<typeof gamesLayer>>, ReplayWake>({
    app: Layer.merge(publicFrameAndManifestStreams, framesLink.routes),
    layer: gamesLayer,
    links: (env) => [wakeLink.client(env.REPLAYS)],
    wakeups: [ProjectionWakeup.attach(frameWake, { concurrency })],
  });

export const DoomGames = gamesHost();

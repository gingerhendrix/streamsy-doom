// SPDX-License-Identifier: GPL-2.0-or-later
import type { DurableObjectNamespace, ExportedHandler, Fetcher } from "@cloudflare/workers-types";
import { routes, type StreamsReader, type StreamsWriter } from "@streamsy/core/protocol";
import { Placement, StreamsyObject, router } from "@streamsy/serve/cloudflare";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";

interface Env { STREAMS: DurableObjectNamespace; ASSETS: Fetcher }
export const DoomStreams = StreamsyObject.make<Env, StreamsReader | StreamsWriter>({
  app: routes({ prefix: "/", maxMessageSize: 2_000_000 }),
  layer: state => DurableObjectStorage.layerProtocol({ client: { storage: state.storage }, longPollTimeoutMs: 20_000 }),
});
// A fork is resolved within one object, including across different session ids.
const streams = router<Env>({ prefix: "/", placement: Placement.byKey(() => "doom"), namespace: env => env.STREAMS });
export default {
  async fetch(request, env, context) {
    return new URL(request.url).pathname.startsWith("/doom/")
      ? streams.fetch!(request, env, context)
      : env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

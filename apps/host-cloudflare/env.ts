// SPDX-License-Identifier: GPL-2.0-or-later
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  DOOM_SNAPSHOT_INTERVAL?: string;
  STREAMS: DurableObjectNamespace;
  GAMES: DurableObjectNamespace;
  REPLAYS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

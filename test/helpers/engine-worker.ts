// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only engine probe. Never mounted by the application Worker.
import type { DurableObjectState, Request as WorkerRequest } from "@cloudflare/workers-types";
import { serverEngine } from "../../apps/host-cloudflare/engine";
import type { Env } from "../../apps/host-cloudflare/worker";
import type { EngineIdentity } from "../../engine/src/engine.js";
import type { HeadlessEngine } from "../../engine/src/headless";
export class EngineProbe {
  private engine?: HeadlessEngine;
  private identity?: EngineIdentity;
  constructor(
    _state: DurableObjectState,
    private readonly env: Env,
  ) {}
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/init") {
      this.identity = (await request.json()) as EngineIdentity;
      this.engine = await (await serverEngine(this.env))(this.identity);
      return Response.json(this.engine.stats());
    }
    if (!this.engine || !this.identity) return new Response(null, { status: 409 });
    if (path === "/reset") this.engine.reset(this.identity);
    const bytes = new Uint8Array(await request.arrayBuffer());
    let drift = 0;
    for (let at = 0; at < bytes.length; at += 9) {
      if (!this.engine.step(bytes.subarray(at, at + 9))) drift++;
      this.engine.stats(); // The projection reads stats after every completed tic.
    }
    return Response.json({
      drift,
      stats: this.engine.stats(),
      memoryAvailable: "memory" in performance,
    });
  }
}
export default {
  fetch(request: WorkerRequest, env: { ENGINE: Env["REPLAYS"] }) {
    return env.ENGINE.get(env.ENGINE.idFromName("engine")).fetch(request);
  },
};

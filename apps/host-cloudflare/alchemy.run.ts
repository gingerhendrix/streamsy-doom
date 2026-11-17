// SPDX-License-Identifier: GPL-2.0-or-later
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";

// These logical ids and the stack name own persistent resources. Keep stable.
const name = "streamsy-doom";
const Streams = Cloudflare.DurableObject("Streams", { className: "DoomStreams", storage: "sqlite" });
export default Alchemy.Stack(name, { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (!["local", "test", "prod"].includes(stage)) throw new Error(`Unknown Doom stage: ${stage}; use local, test or prod`);
    const worker = yield* Cloudflare.Worker("Host", {
      name: `${name}-${stage}`,
      main: fileURLToPath(new URL("./dist/worker/worker.js", import.meta.url)),
      bundle: false,
      compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
      workersDev: stage !== "prod",
      assets: { directory: fileURLToPath(new URL("./dist/assets", import.meta.url)), runWorkerFirst: true },
      env: { STREAMS: Streams },
    });
    return { stage, url: worker.url };
  }));

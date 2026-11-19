// SPDX-License-Identifier: GPL-2.0-or-later
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";

const STACK_NAME_OWNING_DEPLOYED_RESOURCES = "streamsy-doom";
const STAGES = ["local", "test", "prod"];

const pathBesideThisFile = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const sqliteObject = (logicalIdOwningDeployedStorage: string, className: string) =>
  Cloudflare.DurableObject(logicalIdOwningDeployedStorage, { className, storage: "sqlite" });

const RetiredStreamsKeptForItsDeployedState = sqliteObject("Streams", "DoomStreams");
const Games = sqliteObject("Games", "DoomGames");
const Replays = sqliteObject("Replays", "DoomReplay");
const Lobby = sqliteObject("Lobby", "DoomLobby");

export default Alchemy.Stack(
  STACK_NAME_OWNING_DEPLOYED_RESOURCES,
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (!STAGES.includes(stage))
      throw new Error(`Unknown Doom stage: ${stage}; use local, test or prod`);
    const worker = yield* Cloudflare.Worker("Host", {
      name: `${STACK_NAME_OWNING_DEPLOYED_RESOURCES}-${stage}`,
      main: pathBesideThisFile("./dist/worker/worker.js"),
      bundle: false,
      compatibility: { date: "2026-07-30", flags: ["nodejs_compat"] },
      workersDev: stage !== "prod",
      assets: { directory: pathBesideThisFile("./dist/assets"), runWorkerFirst: true },
      env: {
        STREAMS: RetiredStreamsKeptForItsDeployedState,
        GAMES: Games,
        REPLAYS: Replays,
        LOBBY: Lobby,
      },
    });
    return { stage, url: worker.url };
  }),
);

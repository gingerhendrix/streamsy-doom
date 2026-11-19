// SPDX-License-Identifier: GPL-2.0-or-later
import { Streamsy } from "@streamsy/core";
import { ObjectLink, Placement, rule } from "@streamsy/serve/cloudflare";
import {
  Batches,
  Entries,
  Game,
  Leaderboard,
  ReplayWake,
  Sessions,
} from "../../src/streams/declarations";
import { familyOf } from "../../src/streams/ids";
import type { Env } from "./env";

const GAME_OBJECT_PREFIX = "game:";
const REPLAY_OBJECT_PREFIX = "replay:";
const LOBBY_OBJECT_NAME = "lobby:v2";

const gameObjectOf = ({ id }: { id: string }) => `${GAME_OBJECT_PREFIX}${familyOf(id)}`;
const replayObjectOf = ({ id }: { id: string }) => `${REPLAY_OBJECT_PREFIX}${id}`;
const lobbyObject = () => LOBBY_OBJECT_NAME;

export const placement = Placement.byRoute([
  rule({ stream: Sessions, owner: gameObjectOf }),
  rule({ stream: Batches, owner: gameObjectOf }),
  rule({ stream: ReplayWake, owner: replayObjectOf }),
  rule({ stream: Game, owner: replayObjectOf }),
  rule({ stream: Leaderboard, owner: lobbyObject }),
  rule({ stream: Entries, owner: lobbyObject }),
]);

export type ObjectKind = "games" | "replays" | "lobby";

export function objectKindOwning(streamPath: string): ObjectKind {
  const owner = placement.name(streamPath);
  if (owner.startsWith(GAME_OBJECT_PREFIX)) return "games";
  if (owner.startsWith(REPLAY_OBJECT_PREFIX)) return "replays";
  return "lobby";
}

export const replayObject = (env: Env, id: string) =>
  env.REPLAYS.get(env.REPLAYS.idFromName(replayObjectOf({ id })));

export const theLobbyObject = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName(LOBBY_OBJECT_NAME));

export const framesLink = ObjectLink.make({
  group: Streamsy.group(Sessions),
  prefix: "/__frames",
  placement,
  access: "read",
});

export const wakeLink = ObjectLink.make({
  group: Streamsy.group(ReplayWake),
  prefix: "/__wake",
  placement,
  access: "append",
});

export const entriesLink = ObjectLink.make({
  group: Streamsy.group(Entries),
  prefix: "/__entries",
  placement,
  access: "append",
});

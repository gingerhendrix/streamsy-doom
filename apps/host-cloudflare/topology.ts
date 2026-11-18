// SPDX-License-Identifier: GPL-2.0-or-later
import { Streamsy } from "@streamsy/core";
import { ObjectLink, Placement, rule } from "@streamsy/serve/cloudflare";
import { familyOf } from "../../src/streams/ids";
import { Sessions, Batches, ReplayWake, LobbyStream, Scores } from "../../src/streams/v2";

// The router and all internal clients use this exact placement table.
export const placement = Placement.byRoute([
  rule({ stream: Sessions, owner: ({ id }) => `game:${familyOf(id)}` }),
  rule({ stream: Batches, owner: ({ id }) => `game:${familyOf(id)}` }),
  rule({ stream: ReplayWake, owner: ({ id }) => `replay:${id}` }),
  rule({ stream: LobbyStream, owner: () => "lobby:v2" }),
  rule({ stream: Scores, owner: () => "lobby:v2" }),
]);
export const framesLink = ObjectLink.make({ group: Streamsy.group(Sessions), prefix: "/__frames", placement, access: "read" });
export const wakeLink = ObjectLink.make({ group: Streamsy.group(ReplayWake), prefix: "/__wake", placement, access: "append" });
export const scoresLink = ObjectLink.make({ group: Streamsy.group(Scores), prefix: "/__scores", placement, access: "append" });

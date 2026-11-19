// SPDX-License-Identifier: GPL-2.0-or-later
import { Projection } from "@streamsy/projection";
import { ReplayWake, SessionId, Sessions } from "../streams/declarations";

export const frameWake = Projection.wake({
  id: "doom-v2-frame-wake",
  params: { id: SessionId },
  input: Sessions,
  output: ReplayWake,
});

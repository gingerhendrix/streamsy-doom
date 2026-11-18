// SPDX-License-Identifier: GPL-2.0-or-later
import { Projection } from "@streamsy/projection";
import { Sessions, ReplayWake, SessionId } from "../streams/v2";

export const frameWake = Projection.wake({
  id: "doom-v2-frame-wake",
  params: { id: SessionId },
  input: Sessions,
  output: ReplayWake,
});

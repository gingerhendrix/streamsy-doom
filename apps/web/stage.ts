// SPDX-License-Identifier: GPL-2.0-or-later
import type { SessionMetadata } from "../../src/streams/declarations";
import { setText } from "./dom";
import { screens } from "./screens";
import { mainElement, onButtonClick } from "./shell";
import { stageHtml } from "./templates";

const forkDescription = (session: SessionMetadata) =>
  session.forkedFrom ? ` · Fork of ${session.forkedFrom} at tic ${session.forkTic}` : "";

export function showStage(title: string, session: SessionMetadata, controlsHtml: string) {
  mainElement().innerHTML = stageHtml(controlsHtml);
  setText("#heading", title);
  setText(
    "#session",
    `${session.playerName} · Skill ${session.skill} · ${session.id}${forkDescription(session)}`,
  );
  onButtonClick("leave", () => screens().showLobby());
}

export const showWatchUrl = (id: string) => history.replaceState(null, "", `#watch/${id}`);

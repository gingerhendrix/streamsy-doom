// SPDX-License-Identifier: GPL-2.0-or-later
import type { Engine } from "../../engine/src/engine.js";
import type { SessionWriter } from "../../src/streams";

export interface Screens {
  showLobby(): Promise<void>;
  watch(id: string): Promise<void>;
  play(game: Engine, writer: SessionWriter): Promise<void>;
}

type Cleanup = () => Promise<void>;

const nothingToCleanUp: Cleanup = async () => {};

let registered: Screens | undefined;
let cleanUpCurrentScreen = nothingToCleanUp;

export function registerScreens(screens: Screens) {
  registered = screens;
}

export const screens = () => registered!;

export const leaveCurrentScreen = () => cleanUpCurrentScreen();

export function onLeavingScreen(cleanup: Cleanup = nothingToCleanUp) {
  cleanUpCurrentScreen = cleanup;
}

// SPDX-License-Identifier: GPL-2.0-or-later
import { showLobby } from "./lobby-screen";
import { play } from "./play-screen";
import { registerScreens } from "./screens";
import { action, mountShell } from "./shell";
import { watch } from "./watch-screen";
import "./style.css";

const watchRoute = /^#watch\/([a-zA-Z0-9_-]+)$/;

const isPlaying = () => document.querySelector("#end") !== null;

async function openRoute() {
  const id = location.hash.match(watchRoute)?.[1];
  if (id) await watch(id);
  else await showLobby();
}

function askBeforeUnloadingUnsentFrames(event: BeforeUnloadEvent) {
  if (!isPlaying()) return;
  event.preventDefault();
  event.returnValue = "";
}

mountShell();
registerScreens({ showLobby, watch, play });
window.addEventListener("beforeunload", askBeforeUnloadingUnsentFrames);
window.addEventListener("hashchange", () => void action(openRoute));
void action(openRoute);

// SPDX-License-Identifier: GPL-2.0-or-later
import { find, setText } from "./dom";
import { shellHtml } from "./templates";

const SOURCE_NOT_PUBLISHED_HREF = "#source-pending";

let actionInProgress = false;

function showSourceLink() {
  const sourceUrl = (import.meta as ImportMeta & { env: Record<string, string> }).env
    .VITE_SOURCE_URL;
  find<HTMLAnchorElement>("#source").href = sourceUrl || SOURCE_NOT_PUBLISHED_HREF;
  setText(
    "#source-note",
    sourceUrl ? "Engine and client source" : "Repository URL pending publication",
  );
}

export function mountShell() {
  find<HTMLDivElement>("#app").innerHTML = shellHtml;
  showSourceLink();
}

export const mainElement = () => find("main");

export function report(error: unknown) {
  setText("#error", String(error instanceof Error ? error.message : error));
}

export async function action(work: () => Promise<void>) {
  if (actionInProgress) return;
  actionInProgress = true;
  setText("#error", "");
  try {
    await work();
  } catch (error) {
    report(error);
  } finally {
    actionInProgress = false;
  }
}

export const runAction = (work: () => Promise<void>) => () => void action(work);

export const onButtonClick = (id: string, work: () => Promise<void>) =>
  document.getElementById(id)!.addEventListener("click", runAction(work));

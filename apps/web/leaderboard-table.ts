// SPDX-License-Identifier: GPL-2.0-or-later
import { deleteSession, recentFirst } from "../../src/streams";
import type { EntryRow } from "../../src/streams/declarations";
import { client } from "./client";
import { el, find, setText } from "./dom";
import { ownsSession } from "./owned-sessions";
import { screens } from "./screens";
import { runAction } from "./shell";

type Score = EntryRow["score"];

const FAMILY_SEPARATOR_INDEX = 32;
const SHORT_ID_LENGTH = 8;
const NO_VALUE = "—";

const columnLabels = [
  "Player / timeline",
  "Map",
  "Kills",
  "Deaths",
  "Items",
  "Secrets",
  "Verification",
  "Live",
  "Projection age¹",
  "Actions",
];

const shortSessionId = (id: string) =>
  id.slice(FAMILY_SEPARATOR_INDEX + 1, FAMILY_SEPARATOR_INDEX + 1 + SHORT_ID_LENGTH);

function scoreCells(score?: Score) {
  const counters = [score?.kills, score?.deaths, score?.items, score?.secrets];
  return [
    score ? `E${score.episode}M${score.map}` : NO_VALUE,
    ...counters.map((value) => (value === undefined ? NO_VALUE : String(value))),
  ];
}

function verificationCell(score?: Score) {
  const state = !score ? "pending" : score.verified ? "verified" : "unverified";
  const labels = { pending: "Pending", verified: "Verified", unverified: "Drift · unverified" };
  const cell = el("td", labels[state]);
  cell.className = state;
  return cell;
}

function liveLabel(row: EntryRow) {
  if (row.ended) return "Ended";
  if (row.live) return "● Live";
  return row.score ? "○ Idle" : "Pending";
}

const ageText = (receivedAt: number, tic: string) =>
  `Seen ${Math.floor((Date.now() - receivedAt) / 1000)}s ago · tic ${tic}`;

function ageCell(row: EntryRow, receivedAt: Map<string, number>) {
  const cell = el("td", "Awaiting replay");
  if (!row.score) return cell;
  cell.dataset.scoreReceived = String(receivedAt.get(row.id) ?? Date.now());
  cell.dataset.scoreTic = String(row.score.tic);
  cell.textContent = ageText(Number(cell.dataset.scoreReceived), cell.dataset.scoreTic);
  return cell;
}

export function refreshAgeCells() {
  for (const cell of document.querySelectorAll<HTMLElement>("[data-score-received]"))
    cell.textContent = ageText(Number(cell.dataset.scoreReceived), cell.dataset.scoreTic!);
}

function nameCell(row: EntryRow) {
  const cell = document.createElement("td");
  cell.append(el("strong", row.playerName), el("br", ""), el("code", shortSessionId(row.id)));
  if (row.forkedFrom) cell.append(el("p", `Forked at ${row.forkTic}`));
  return cell;
}

function deleteButton(id: string) {
  const button = el("button", "Delete");
  button.addEventListener(
    "click",
    runAction(async () => {
      button.disabled = true;
      try {
        await deleteSession(client, id);
      } finally {
        button.disabled = false;
      }
    }),
  );
  return button;
}

function actionsCell(row: EntryRow) {
  const cell = document.createElement("td");
  const watchButton = el("button", "Watch");
  watchButton.addEventListener(
    "click",
    runAction(() => screens().watch(row.id)),
  );
  cell.append(watchButton);
  if (ownsSession(row.id)) cell.append(deleteButton(row.id));
  return cell;
}

function sessionRow(row: EntryRow, receivedAt: Map<string, number>) {
  const tr = document.createElement("tr");
  tr.dataset.id = row.id;
  tr.append(nameCell(row));
  for (const text of scoreCells(row.score)) {
    const cell = el("td", text);
    cell.className = "num";
    tr.append(cell);
  }
  tr.append(
    verificationCell(row.score),
    el("td", liveLabel(row)),
    ageCell(row, receivedAt),
    actionsCell(row),
  );
  return tr;
}

function headerRow() {
  const tr = document.createElement("tr");
  for (const label of columnLabels) tr.append(el("th", label));
  return tr;
}

export function renderLeaderboard(rows: EntryRow[], receivedAt = new Map<string, number>()) {
  rows.sort(recentFirst);
  const container = find("#sessions");
  container.replaceChildren();
  setText("#count", `(${rows.length})`);
  if (!rows.length) {
    container.append(el("p", "No sessions yet. Start the first game."));
    return;
  }
  const table = document.createElement("table");
  table.append(headerRow(), ...rows.map((row) => sessionRow(row, receivedAt)));
  container.append(table);
}

// SPDX-License-Identifier: GPL-2.0-or-later
const STORAGE_KEY = "doom-owned";

const owned = new Set<string>(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));

export const ownsSession = (id: string) => owned.has(id);

export function rememberOwnedSession(id: string) {
  owned.add(id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...owned]));
}

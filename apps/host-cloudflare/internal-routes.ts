// SPDX-License-Identifier: GPL-2.0-or-later
export const INTERNAL_PREFIX = "/__";
export const INIT_LOBBY_ROUTE = "/__init-lobby";
export const INIT_REPLAY_ROUTE = "/__init-replay";
export const BOOTSTRAP_REPLAY_PREFIX = "/__bootstrap/";

export const internalUrl = (route: string) => `https://internal${route}`;

export const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

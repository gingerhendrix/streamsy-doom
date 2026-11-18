// SPDX-License-Identifier: GPL-2.0-or-later
import { familyOf } from "../streams/ids";
import type { SnapshotTableApi } from "../projection/snapshots";
export interface SnapshotRoute {
  id: string;
  tic?: number;
}
/** Match this namespace before Streamsy placement; it is a read-only table API. */
export function snapshotRoute(
  request: Pick<Request, "url" | "method">,
): SnapshotRoute | Response | undefined {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/doom/v2/server-snapshots/")) return;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const parts = path.slice("/doom/v2/server-snapshots/".length).split("/");
  if (parts.length > 2) return new Response(null, { status: 404 });
  const [id, value] = parts;
  try {
    familyOf(id);
  } catch {
    return new Response("Invalid v2 session id", { status: 400 });
  }
  if (value === undefined) return { id };
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    return new Response("Invalid snapshot tic", { status: 400 });
  return { id, tic: Number(value) };
}
export function snapshotResponse(
  request: Pick<Request, "url" | "method">,
  route: SnapshotRoute,
  table: SnapshotTableApi,
) {
  if (route.tic === undefined) {
    const body = JSON.stringify(table.entries(route.id));
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Length": String(new TextEncoder().encode(body).length),
      },
    });
  }
  const row = table.load(route.id, route.tic);
  if (!row) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(request.method === "HEAD" ? null : (row.bytes as BodyInit), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.bytes.length),
      "Cache-Control": `public, max-age=${Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000))}, immutable`,
    },
  });
}

// SPDX-License-Identifier: GPL-2.0-or-later
import type { SnapshotTableApi } from "../storage/snapshot-table";
import { isSessionId } from "../streams/ids";
import { SNAPSHOTS_PREFIX } from "../streams/paths";
import {
  emptyResponse,
  invalidSessionIdResponse,
  isReadMethod,
  NO_STORE,
  pathnameOf,
} from "./responses";

const ROUTE_PREFIX = `/${SNAPSHOTS_PREFIX}/`;
const canonicalNonNegativeInteger = /^(0|[1-9][0-9]*)$/;

type ReadRequest = Pick<Request, "url" | "method">;

export interface SnapshotRoute {
  id: string;
  tic?: number;
}

function parseTic(text: string) {
  const tic = Number(text);
  return canonicalNonNegativeInteger.test(text) && Number.isSafeInteger(tic) ? tic : undefined;
}

export function snapshotRoute(request: ReadRequest): SnapshotRoute | Response | undefined {
  const path = pathnameOf(request);
  if (!path.startsWith(ROUTE_PREFIX)) return undefined;
  if (!isReadMethod(request.method)) return emptyResponse(405, { Allow: "GET, HEAD" });
  const segments = path.slice(ROUTE_PREFIX.length).split("/");
  if (segments.length > 2) return emptyResponse(404);
  const [id, ticText] = segments;
  if (!isSessionId(id)) return invalidSessionIdResponse();
  if (ticText === undefined) return { id };
  const tic = parseTic(ticText);
  if (tic === undefined) return new Response("Invalid snapshot tic", { status: 400 });
  return { id, tic };
}

const bodyUnlessHead = (request: ReadRequest, body: BodyInit) =>
  request.method === "HEAD" ? null : body;

function snapshotIndexResponse(request: ReadRequest, id: string, table: SnapshotTableApi) {
  const body = JSON.stringify(table.entries(id));
  return new Response(bodyUnlessHead(request, body), {
    headers: {
      "Content-Type": "application/json",
      ...NO_STORE,
      "Content-Length": String(new TextEncoder().encode(body).length),
    },
  });
}

function snapshotBytesResponse(
  request: ReadRequest,
  id: string,
  tic: number,
  table: SnapshotTableApi,
) {
  const snapshot = table.load(id, tic);
  if (!snapshot) return emptyResponse(404, NO_STORE);
  const secondsUntilExpiry = Math.max(0, Math.floor((snapshot.expiresAt - Date.now()) / 1000));
  return new Response(bodyUnlessHead(request, snapshot.bytes as BodyInit), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(snapshot.bytes.length),
      "Cache-Control": `public, max-age=${secondsUntilExpiry}, immutable`,
    },
  });
}

export function snapshotResponse(
  request: ReadRequest,
  route: SnapshotRoute,
  table: SnapshotTableApi,
) {
  return route.tic === undefined
    ? snapshotIndexResponse(request, route.id, table)
    : snapshotBytesResponse(request, route.id, route.tic, table);
}

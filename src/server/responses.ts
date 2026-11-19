// SPDX-License-Identifier: GPL-2.0-or-later
export const NO_STORE = { "Cache-Control": "no-store" };

export const emptyResponse = (status: number, headers?: Record<string, string>) =>
  new Response(null, { status, headers });

export const invalidSessionIdResponse = () =>
  new Response("Invalid v2 session id", { status: 400 });

export const isReadMethod = (method: string) => method === "GET" || method === "HEAD";

export const pathnameOf = (request: Pick<Request, "url">) => new URL(request.url).pathname;

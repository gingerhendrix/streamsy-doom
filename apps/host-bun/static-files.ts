// SPDX-License-Identifier: GPL-2.0-or-later
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { emptyResponse, isReadMethod } from "../../src/server/responses";

export async function staticFileResponse(directory: string, request: Request) {
  if (!isReadMethod(request.method)) return emptyResponse(405);
  const { pathname } = new URL(request.url);
  const relativePath = "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  try {
    const path = await realpath(resolve(directory, relativePath));
    const isInsideDirectory = path.startsWith(directory + sep);
    if (!isInsideDirectory) return emptyResponse(404);
    const file = Bun.file(path);
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type },
    });
  } catch {
    return emptyResponse(404);
  }
}

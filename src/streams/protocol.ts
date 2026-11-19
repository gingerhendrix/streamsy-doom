// SPDX-License-Identifier: GPL-2.0-or-later
import { concat, parseJsonArray } from "./bytes";
import { expiryHeadersThatProjectionReadsCannotExtend } from "./expiry";

export const BINARY = "application/octet-stream";
export const JSON_CONTENT = "application/json";
export const STREAM_START = "-1";

const REVALIDATE_GROWING_STREAM = "no-cache";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ReadBatch {
  bytes: Uint8Array;
  offset: string;
  upToDate: boolean;
  closed: boolean;
  cursor?: string;
}

export const offsetOf = (response: Response) => {
  const offset = response.headers.get("Stream-Next-Offset");
  if (!offset) throw new Error("Missing Stream-Next-Offset");
  return offset;
};

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ProtocolClient {
  constructor(
    readonly baseUrl: string,
    readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {}

  private resolve(path: string) {
    const directory = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    return new URL(path, directory);
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Cache-Control", REVALIDATE_GROWING_STREAM);
    const response = await this.fetcher(this.resolve(path), {
      ...init,
      headers,
      cache: "no-store",
    });
    if (!response.ok) {
      const method = init.method ?? "GET";
      const detail = await response.text();
      throw new ProtocolError(`${method} ${path}: ${response.status} ${detail}`, response.status);
    }
    return response;
  }

  async create(
    path: string,
    body: Uint8Array | string,
    options: { contentType?: string; headers?: Record<string, string> } = {},
  ) {
    return this.request(path, {
      method: "PUT",
      headers: {
        "Content-Type": options.contentType ?? BINARY,
        ...expiryHeadersThatProjectionReadsCannotExtend(path),
        ...options.headers,
      },
      body: body as BodyInit,
    });
  }

  async append(
    path: string,
    body: Uint8Array | string,
    contentType = BINARY,
    headers: Record<string, string> = {},
  ) {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": contentType, ...headers },
      body: body as BodyInit,
    });
  }

  async read(
    path: string,
    offset = STREAM_START,
    live = false,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<ReadBatch> {
    const query = new URLSearchParams({ offset });
    if (live) query.set("live", "long-poll");
    if (cursor) query.set("cursor", cursor);
    const response = await this.request(`${path}?${query}`, { signal });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      offset: offsetOf(response),
      upToDate: response.headers.get("Stream-Up-To-Date") === "true",
      closed: response.headers.get("Stream-Closed") === "true",
      cursor: response.headers.get("Stream-Cursor") ?? undefined,
    };
  }

  private async *pagesUntilUpToDate(path: string) {
    let offset = STREAM_START;
    while (true) {
      const page = await this.read(path, offset);
      yield page.bytes;
      if (page.upToDate) return;
      if (page.offset === offset) throw new Error("Read made no progress");
      offset = page.offset;
    }
  }

  async all(path: string) {
    const pages: Uint8Array[] = [];
    for await (const page of this.pagesUntilUpToDate(path)) pages.push(page);
    return concat(pages);
  }

  async json<T>(path: string): Promise<T[]> {
    const events: T[] = [];
    for await (const page of this.pagesUntilUpToDate(path)) events.push(...parseJsonArray<T>(page));
    return events;
  }

  async remove(path: string) {
    const response = await this.fetcher(this.resolve(path), { method: "DELETE" });
    const alreadyRemoved = response.status === 404;
    if (!response.ok && !alreadyRemoved) throw new Error(`DELETE ${path}: ${response.status}`);
  }
}

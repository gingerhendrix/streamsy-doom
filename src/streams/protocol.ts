// SPDX-License-Identifier: GPL-2.0-or-later
import { isFamilyId } from "./ids";
export const binary = "application/octet-stream";
export const sessionPath = (id: string) => `${isFamilyId(id) ? "doom/v2" : "doom"}/sessions/${validId(id)}`;
export const batchPath = (id: string) => `${isFamilyId(id) ? "doom/v2" : "doom"}/batches/${validId(id)}`;
export const indexPath = (id: string) => isFamilyId(id) ? `doom/v2/snapshot-index/${id}` : `doom/snapshots/${validId(id)}-idx`;
export const snapshotPath = (id: string, tic: number) => isFamilyId(id) ? `doom/v2/snapshots/${id}/${uint32(tic)}` : `doom/snapshots/${validId(id)}-${uint32(tic)}`;
export function validId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid session id");
  return id;
}
export function uint32(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Expected u32");
  return value;
}
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
export const offsetOf = (response: Response) => {
  const value = response.headers.get("Stream-Next-Offset");
  if (!value) throw new Error("Missing Stream-Next-Offset");
  return value;
};
export class ProtocolError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export class ProtocolClient {
  constructor(readonly baseUrl: string, readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)) {}
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    // Revalidate all growing streams, including first reads and repeated long polls.
    headers.set("Cache-Control", "no-cache");
    const response = await this.fetcher(new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/"), {
      ...init, headers, cache: "no-store",
    });
    if (!response.ok) throw new ProtocolError(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`, response.status);
    return response;
  }
  async create(path: string, body: Uint8Array | string, type = binary, ttl = 43200, extra: Record<string, string> = {}) {
    return this.request(path, { method: "PUT", headers: { "Content-Type": type, "Stream-TTL": String(ttl), ...extra }, body: body as BodyInit });
  }
  async append(path: string, body: Uint8Array | string, type = binary, extra: Record<string, string> = {}) {
    return this.request(path, { method: "POST", headers: { "Content-Type": type, ...extra }, body: body as BodyInit });
  }
  async read(path: string, offset = "-1", live = false, signal?: AbortSignal, cursor?: string) {
    const query = new URLSearchParams({ offset });
    if (live) query.set("live", "long-poll");
    if (cursor) query.set("cursor", cursor);
    const response = await this.request(`${path}?${query}`, { signal });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()), offset: offsetOf(response),
      upToDate: response.headers.get("Stream-Up-To-Date") === "true",
      closed: response.headers.get("Stream-Closed") === "true",
      cursor: response.headers.get("Stream-Cursor") ?? undefined,
    };
  }
  async all(path: string) {
    let offset = "-1";
    const chunks: Uint8Array[] = [];
    do {
      const batch = await this.read(path, offset);
      chunks.push(batch.bytes);
      if (batch.upToDate) break;
      if (batch.offset === offset) throw new Error("Read made no progress");
      offset = batch.offset;
    } while (true);
    return concat(chunks);
  }
  async json<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    let offset = "-1";
    do {
      const batch = await this.read(path, offset);
      // Each HTTP response is its own JSON array, including paginated reads.
      const parsed = JSON.parse(new TextDecoder().decode(batch.bytes) || "[]");
      if (!Array.isArray(parsed)) throw new Error("Expected JSON stream array");
      result.push(...parsed as T[]);
      if (batch.upToDate) return result;
      if (batch.offset === offset) throw new Error("Read made no progress");
      offset = batch.offset;
    } while (true);
  }
  async remove(path: string) {
    const response = await this.fetcher(new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/"), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`DELETE ${path}: ${response.status}`);
  }
}
export function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
  let at = 0;
  for (const p of parts) { result.set(p, at); at += p.length; }
  return result;
}

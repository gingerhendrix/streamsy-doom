// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, ProtocolError, offsetOf } from "./protocol";

export type LiveTransport = "catch-up" | "websocket" | "long-poll";
export interface FollowOptions<T> {
  signal: AbortSignal;
  from?: string;
  onBatch: (events: T[]) => void;
  onTransport?: (transport: LiveTransport) => void;
  // Injection also lets a browser-shaped client exercise the real workerd socket.
  socket?: (url: string) => WebSocket;
  websocket?: boolean;
}
const decode = <T>(bytes: Uint8Array): T[] => {
  const events = JSON.parse(new TextDecoder().decode(bytes) || "[]");
  if (!Array.isArray(events)) throw new Error("Expected JSON stream array");
  return events;
};
const retryDelay = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });

/** HTTP catch-up, then hibernatable Cloudflare sockets or portable long poll.
 * Offsets are opaque and advance only on completed HTTP batches/socket controls.
 */
export async function followJson<T>(
  client: ProtocolClient,
  path: string,
  options: FollowOptions<T>,
) {
  const { signal, onBatch, onTransport } = options;
  let offset = options.from ?? "-1",
    cursor: string | undefined,
    live = false;
  let useSocket =
    options.websocket !== false &&
    (options.socket !== undefined || typeof WebSocket !== "undefined");
  try {
    while (!signal.aborted) {
      onTransport?.(live ? "long-poll" : "catch-up");
      let batch: Awaited<ReturnType<ProtocolClient["read"]>>;
      try {
        batch = await client.read(path, offset, live, signal, cursor);
      } catch (error) {
        // State streams are created by trusted bootstrap, never by a browser PUT.
        if (error instanceof ProtocolError && error.status === 404) {
          await retryDelay(signal);
          continue;
        }
        throw error;
      }
      if (signal.aborted) return;
      options.onBatch(decode<T>(batch.bytes));
      const before = offset;
      offset = batch.offset;
      cursor = batch.cursor;
      live = batch.upToDate;
      if (batch.closed) return;
      if (!live && offset === before) throw new Error("Read made no progress");
      if (!live || !useSocket) continue;
      const url = new URL(path, client.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("offset", offset);
      url.searchParams.set("live", "websocket");
      if (cursor) url.searchParams.set("cursor", cursor);
      const result = await new Promise<"fallback" | "catch-up" | "closed">((resolve, reject) => {
        const ws = options.socket
          ? options.socket(url.href)
          : new WebSocket(url.href, "streamsy-live.v1");
        ws.binaryType = "arraybuffer";
        let pending: T[] = [],
          finished = false;
        const finish = (result: "fallback" | "catch-up" | "closed") => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", abort);
          ws.close();
          resolve(result);
        };
        const abort = () => finish("closed");
        signal.addEventListener("abort", abort, { once: true });
        ws.onopen = () => onTransport?.("websocket");
        ws.onmessage = (event) => {
          if (finished) return;
          try {
            if (typeof event.data !== "string")
              pending.push(...decode<T>(new Uint8Array(event.data)));
            else {
              const frame = JSON.parse(event.data);
              if (frame.type === "control") {
                if (typeof frame.streamNextOffset !== "string")
                  throw new Error("Missing socket offset");
                onBatch(pending);
                pending = [];
                offset = frame.streamNextOffset;
                cursor = frame.streamCursor;
                if (frame.streamClosed) finish("closed");
              }
            }
          } catch (error) {
            if (!finished) {
              finished = true;
              signal.removeEventListener("abort", abort);
              ws.close();
              reject(error);
            }
          }
        };
        // Browsers hide the handshake status (including Bun's 426). Any upgrade
        // failure or broken socket resumes HTTP from the last control offset.
        ws.onerror = () => finish("fallback");
        ws.onclose = (event) =>
          finish(event.code === 4100 || event.code === 1012 ? "catch-up" : "fallback");
        if (signal.aborted) abort();
      });
      if (result === "closed") return;
      if (result === "fallback") useSocket = false;
      live = false;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/** Apply one consistent State snapshot, then resume at its opaque offset. */
export async function followState<T>(
  client: ProtocolClient,
  options: FollowOptions<T> & { snapshot: string; stream: string },
) {
  try {
    const response = await client.request(options.snapshot, { signal: options.signal });
    const events = await response.json();
    if (!Array.isArray(events)) throw new Error("Expected State snapshot array");
    const from = offsetOf(response);
    if (options.signal.aborted) return;
    options.onBatch(events);
    await followJson<T>(client, options.stream, { ...options, from });
  } catch (error) {
    if (!options.signal.aborted) throw error;
  }
}

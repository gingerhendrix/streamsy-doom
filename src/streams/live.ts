// SPDX-License-Identifier: GPL-2.0-or-later
import { parseJsonArray } from "./bytes";
import { offsetOf, ProtocolError, STREAM_START, type ProtocolClient } from "./protocol";

const RETRY_MISSING_STREAM_AFTER_MS = 1000;
const LIVE_SOCKET_SUBPROTOCOL = "streamsy-live.v1";
const CLOSE_CATCH_UP_REQUIRED = 4100;
const CLOSE_SERVICE_RESTART = 1012;

export type LiveTransport = "catch-up" | "websocket" | "long-poll";

export interface FollowOptions<T> {
  signal: AbortSignal;
  from?: string;
  onBatch: (events: T[]) => void;
  onTransport?: (transport: LiveTransport) => void;
  socket?: (url: string) => WebSocket;
  websocket?: boolean;
}

interface StreamPosition {
  offset: string;
  cursor?: string;
}

type SocketOutcome = "stream-ended-or-aborted" | "catch-up-over-http" | "socket-unavailable";

const sleepUnlessAborted = (signal: AbortSignal, milliseconds: number) =>
  new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, milliseconds);
    signal.addEventListener("abort", wake, { once: true });
    if (signal.aborted) wake();
  });

const isStreamNotCreatedYet = (error: unknown) =>
  error instanceof ProtocolError && error.status === 404;

function liveSocketUrl(client: ProtocolClient, path: string, position: StreamPosition) {
  const url = new URL(path, client.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("offset", position.offset);
  url.searchParams.set("live", "websocket");
  if (position.cursor) url.searchParams.set("cursor", position.cursor);
  return url.href;
}

function followSocketUntilItEnds<T>(
  url: string,
  position: StreamPosition,
  options: FollowOptions<T>,
) {
  const { signal, onBatch, onTransport } = options;
  return new Promise<SocketOutcome>((resolve, reject) => {
    const socket = options.socket
      ? options.socket(url)
      : new WebSocket(url, LIVE_SOCKET_SUBPROTOCOL);
    socket.binaryType = "arraybuffer";
    let eventsAwaitingOffset: T[] = [];
    let settled = false;

    const release = () => {
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.close();
    };
    const finish = (outcome: SocketOutcome) => {
      if (settled) return;
      release();
      resolve(outcome);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      release();
      reject(error);
    };
    const onAbort = () => finish("stream-ended-or-aborted");

    const deliverAtControlOffset = (control: {
      streamNextOffset?: unknown;
      streamCursor?: string;
      streamClosed?: boolean;
    }) => {
      if (typeof control.streamNextOffset !== "string") throw new Error("Missing socket offset");
      onBatch(eventsAwaitingOffset);
      eventsAwaitingOffset = [];
      position.offset = control.streamNextOffset;
      position.cursor = control.streamCursor;
      if (control.streamClosed) finish("stream-ended-or-aborted");
    };

    signal.addEventListener("abort", onAbort, { once: true });
    socket.onopen = () => onTransport?.("websocket");
    socket.onmessage = (message) => {
      if (settled) return;
      try {
        if (typeof message.data !== "string") {
          eventsAwaitingOffset.push(...parseJsonArray<T>(new Uint8Array(message.data)));
          return;
        }
        const frame = JSON.parse(message.data);
        if (frame.type === "control") deliverAtControlOffset(frame);
      } catch (error) {
        fail(error);
      }
    };
    socket.onerror = () => finish("socket-unavailable");
    socket.onclose = (close) => {
      const serverAskedForCatchUp =
        close.code === CLOSE_CATCH_UP_REQUIRED || close.code === CLOSE_SERVICE_RESTART;
      finish(serverAskedForCatchUp ? "catch-up-over-http" : "socket-unavailable");
    };
    if (signal.aborted) onAbort();
  });
}

export async function followJson<T>(
  client: ProtocolClient,
  path: string,
  options: FollowOptions<T>,
) {
  const { signal, onBatch, onTransport } = options;
  const position: StreamPosition = { offset: options.from ?? STREAM_START };
  let caughtUp = false;
  let socketAvailable =
    options.websocket !== false &&
    (options.socket !== undefined || typeof WebSocket !== "undefined");
  try {
    while (!signal.aborted) {
      onTransport?.(caughtUp ? "long-poll" : "catch-up");
      let page: Awaited<ReturnType<ProtocolClient["read"]>>;
      try {
        page = await client.read(path, position.offset, caughtUp, signal, position.cursor);
      } catch (error) {
        if (!isStreamNotCreatedYet(error)) throw error;
        await sleepUnlessAborted(signal, RETRY_MISSING_STREAM_AFTER_MS);
        continue;
      }
      if (signal.aborted) return;
      onBatch(parseJsonArray<T>(page.bytes));
      const madeProgress = page.offset !== position.offset;
      position.offset = page.offset;
      position.cursor = page.cursor;
      caughtUp = page.upToDate;
      if (page.closed) return;
      if (!caughtUp && !madeProgress) throw new Error("Read made no progress");
      if (!caughtUp || !socketAvailable) continue;

      const outcome = await followSocketUntilItEnds(
        liveSocketUrl(client, path, position),
        position,
        options,
      );
      if (outcome === "stream-ended-or-aborted") return;
      if (outcome === "socket-unavailable") socketAvailable = false;
      caughtUp = false;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export async function followState<T>(
  client: ProtocolClient,
  options: FollowOptions<T> & { snapshot: string; stream: string },
) {
  try {
    const snapshot = await client.request(options.snapshot, { signal: options.signal });
    const events = await snapshot.json();
    if (!Array.isArray(events)) throw new Error("Expected State snapshot array");
    const offsetAfterSnapshot = offsetOf(snapshot);
    if (options.signal.aborted) return;
    options.onBatch(events);
    await followJson<T>(client, options.stream, { ...options, from: offsetAfterSnapshot });
  } catch (error) {
    if (!options.signal.aborted) throw error;
  }
}

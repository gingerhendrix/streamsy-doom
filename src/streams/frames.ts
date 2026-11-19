// SPDX-License-Identifier: GPL-2.0-or-later
export const FRAME_BYTES = 9;
export const TICS_PER_SECOND = 35;
export const MAX_TIC = 0xffffffff;
export const SESSION_FORMAT_VERSION = 1;

const LINE_FEED = 10;

export function validTic(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIC) throw new Error("Expected u32");
  return value;
}

export const isFrame = (bytes: Uint8Array) => bytes.length === FRAME_BYTES;

export const wholeFramesByteLength = (byteLength: number) =>
  Math.floor(byteLength / FRAME_BYTES) * FRAME_BYTES;

export function* frameOffsets(frames: Uint8Array) {
  for (let offset = 0; offset < frames.length; offset += FRAME_BYTES) yield offset;
}

export const frameAt = (frames: Uint8Array, offset: number) =>
  frames.subarray(offset, offset + FRAME_BYTES);

export function splitFirstLine(bytes: Uint8Array) {
  const lineEnd = bytes.indexOf(LINE_FEED);
  if (lineEnd < 0) return undefined;
  return { line: bytes.subarray(0, lineEnd), rest: bytes.subarray(lineEnd + 1) };
}

export const parseJsonLine = (line: Uint8Array) => JSON.parse(new TextDecoder().decode(line));

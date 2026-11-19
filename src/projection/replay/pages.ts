// SPDX-License-Identifier: GPL-2.0-or-later
import { Schema } from "effect";
import { concat } from "../../streams/bytes";
import {
  parseJsonLine,
  SESSION_FORMAT_VERSION,
  splitFirstLine,
  wholeFramesByteLength,
} from "../../streams/frames";
import { IdentitySchema, type DecoderState } from "./state";

const MAX_HEADER_BYTES = 65536;
const NO_FRAMES = new Uint8Array(0);

export interface DecodedPages {
  header: DecoderState["header"];
  tail: number[];
  frames: Uint8Array;
}

function assertHeaderFits(byteLength: number) {
  if (byteLength > MAX_HEADER_BYTES) throw new Error("Session header too large");
}

function decodeHeader(line: Uint8Array) {
  assertHeaderFits(line.length);
  const header = parseJsonLine(line);
  if (header.formatVersion !== SESSION_FORMAT_VERSION)
    throw new Error("Unsupported session format");
  return Schema.decodeUnknownSync(IdentitySchema)(header);
}

function splitWholeFrames(header: DecoderState["header"], bytes: Uint8Array): DecodedPages {
  const wholeFramesEnd = wholeFramesByteLength(bytes.length);
  return {
    header,
    tail: [...bytes.subarray(wholeFramesEnd)],
    frames: bytes.subarray(0, wholeFramesEnd),
  };
}

export function decodePages(state: DecoderState, pages: readonly Uint8Array[]): DecodedPages {
  const bytes = concat([new Uint8Array(state.tail), ...pages]);
  if (state.header) return splitWholeFrames(state.header, bytes);
  const split = splitFirstLine(bytes);
  if (!split) {
    assertHeaderFits(bytes.length);
    return { header: null, tail: [...bytes], frames: NO_FRAMES };
  }
  return splitWholeFrames(decodeHeader(split.line), split.rest);
}

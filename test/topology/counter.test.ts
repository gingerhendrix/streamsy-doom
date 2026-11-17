// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { decodePages, initialStats } from "../../src/projection/stats";
import { familyOf, isFamilyId, newSessionId, newForkId } from "../../src/streams/ids";
import { concat, encode } from "../../src/streams/protocol";

test("decoder checkpoints survive every header/frame split and JSON serialization", () => {
  const identity = { version: 2, buildId: "test", wadSha256: "test", skill: 3, episode: 1, map: 1 };
  const bytes = concat([encode({ formatVersion: 1, ...identity, playerName: "Démon 👹" }), ...Array.from({ length: 19 }, () => new Uint8Array(9))]);
  for (let split = 0; split <= bytes.length; split++) {
    const first = decodePages(initialStats(), [bytes.subarray(0, split)]);
    const checkpoint = JSON.parse(JSON.stringify({ header: first.header, tail: first.tail }));
    const second = decodePages(checkpoint, [bytes.subarray(split)]);
    expect(first.frames.length + second.frames.length).toBe(19 * 9);
    expect(second.tail).toEqual([]); expect(second.header).toEqual(identity);
  }
  let checkpoint = { header: null as typeof identity | null, tail: [] as number[] }, count = 0;
  for (const byte of bytes) {
    const decoded = decodePages(checkpoint, [new Uint8Array([byte])]);
    count += decoded.frames.length / 9;
    checkpoint = JSON.parse(JSON.stringify({ header: decoded.header, tail: decoded.tail }));
  }
  expect(count).toBe(19);
  expect(() => decodePages(initialStats(), [encode({ formatVersion: 2 })])).toThrow("Unsupported");
  expect(() => decodePages(initialStats(), [new Uint8Array(65537).fill(65)])).toThrow("header too large");
});
test("IDs use the exact lowercase grammar and preserve family through grandchildren", () => {
  const root = newSessionId(), second = newSessionId(), child = newForkId(root), grandchild = newForkId(child);
  expect(root.length).toBe(65); expect(isFamilyId(root)).toBe(true);
  expect(familyOf(root)).not.toBe(familyOf(second));
  expect(familyOf(child)).toBe(familyOf(root)); expect(familyOf(grandchild)).toBe(familyOf(root));
  for (const invalid of ["", root.toUpperCase(), root.slice(1), root + "\n", root.replace("_", "__"), "a_b", "g".repeat(32) + "_" + "a".repeat(32)]) {
    expect(isFamilyId(invalid)).toBe(false); expect(() => familyOf(invalid)).toThrow("Invalid v2");
  }
});

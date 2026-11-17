// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { countFrames, type Counter } from "../../src/projection/counter";
import { familyOf, isFamilyId, newSessionId, newForkId } from "../../src/streams/ids";
import { concat, encode } from "../../src/streams/protocol";

test("counter checkpoints survive every header/frame split and JSON serialization", () => {
  const bytes = concat([encode({ formatVersion: 1, playerName: "Démon 👹" }), ...Array.from({ length: 19 }, () => new Uint8Array(9))]);
  const initial: Counter = { header: false, tail: [], tic: 0 };
  for (let split = 0; split <= bytes.length; split++) {
    const checkpoint = JSON.parse(JSON.stringify(countFrames(initial, [bytes.subarray(0, split)]))) as Counter;
    expect(countFrames(checkpoint, [bytes.subarray(split)])).toEqual({ header: true, tail: [], tic: 19 });
  }
  let checkpoint = initial;
  for (const byte of bytes) checkpoint = JSON.parse(JSON.stringify(countFrames(checkpoint, [new Uint8Array([byte])])));
  expect(checkpoint).toEqual({ header: true, tail: [], tic: 19 });
  expect(() => countFrames(initial, [encode({ formatVersion: 2 })])).toThrow("Unsupported");
  expect(() => countFrames(initial, [new Uint8Array(65537).fill(65)])).toThrow("header too large");
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

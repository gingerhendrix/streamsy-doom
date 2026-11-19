// SPDX-License-Identifier: GPL-2.0-or-later
export function concat(parts: Uint8Array[]) {
  const totalLength = parts.reduce((length, part) => length + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export const encodeJsonLine = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value) + "\n");

export function parseJsonArray<T>(bytes: Uint8Array): T[] {
  const parsed = JSON.parse(new TextDecoder().decode(bytes) || "[]");
  if (!Array.isArray(parsed)) throw new Error("Expected JSON stream array");
  return parsed;
}

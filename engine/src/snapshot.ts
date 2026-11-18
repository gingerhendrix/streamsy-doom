// SPDX-License-Identifier: GPL-2.0-or-later
import type { EngineIdentity } from "./engine.js";
/** Stream a post-init XOR into native gzip without a second whole-heap copy. */
export async function compressSnapshot(
  identity: EngineIdentity,
  tic: number,
  heap: Uint8Array,
  baseline: Uint8Array,
) {
  const gzip = new CompressionStream("gzip"),
    writer = gzip.writable.getWriter();
  const result = new Response(gzip.readable).arrayBuffer();
  // Observe a compression failure even while a writer operation is pending.
  result.catch(() => {});
  try {
    await writer.write(new TextEncoder().encode(JSON.stringify({ ...identity, tic }) + "\n"));
    const delta = new Uint8Array(Math.min(65536, heap.length));
    for (let at = 0; at < heap.length; at += delta.length) {
      const length = Math.min(delta.length, heap.length - at);
      for (let n = 0; n < length; n++) delta[n] = heap[at + n] ^ baseline[at + n];
      // The write settles after this chunk is compressed, so its buffer can
      // be reused without retaining 256 separate XOR allocations until GC.
      await writer.write(delta.subarray(0, length));
    }
    await writer.close();
    return new Uint8Array(await result);
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await result.catch(() => {});
    throw error;
  }
}

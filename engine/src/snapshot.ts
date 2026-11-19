// SPDX-License-Identifier: GPL-2.0-or-later
import type { EngineIdentity } from "./engine.js";

const XOR_CHUNK_BYTES = 65536;

const markRejectionAsHandledUntilAwaited = (promise: Promise<unknown>) => {
  promise.catch(() => {});
};

export async function compressSnapshot(
  identity: EngineIdentity,
  tic: number,
  heap: Uint8Array,
  heapAfterInit: Uint8Array,
) {
  const gzip = new CompressionStream("gzip");
  const writer = gzip.writable.getWriter();
  const compressed = new Response(gzip.readable).arrayBuffer();
  markRejectionAsHandledUntilAwaited(compressed);
  try {
    const metadataLine = JSON.stringify({ ...identity, tic }) + "\n";
    await writer.write(new TextEncoder().encode(metadataLine));

    const chunkReusedAfterEachWriteSettles = new Uint8Array(Math.min(XOR_CHUNK_BYTES, heap.length));
    for (let start = 0; start < heap.length; start += chunkReusedAfterEachWriteSettles.length) {
      const length = Math.min(chunkReusedAfterEachWriteSettles.length, heap.length - start);
      for (let index = 0; index < length; index++)
        chunkReusedAfterEachWriteSettles[index] =
          heap[start + index] ^ heapAfterInit[start + index];
      await writer.write(chunkReusedAfterEachWriteSettles.subarray(0, length));
    }
    await writer.close();
    return new Uint8Array(await compressed);
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await compressed.catch(() => {});
    throw error;
  }
}

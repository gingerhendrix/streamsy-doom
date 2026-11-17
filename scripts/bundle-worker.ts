// SPDX-License-Identifier: GPL-2.0-or-later
import { cp, mkdir } from "node:fs/promises";
/** Keep WASM as an actual module import, rather than Bun's asset URL loader. */
export async function bundleWorker(entrypoint: string, outdir: string, naming = "worker.js") {
  await mkdir(outdir, { recursive: true });
  const result = await Bun.build({ entrypoints: [entrypoint], outdir, naming, target: "browser", format: "esm",
    external: ["cloudflare:workers", "*.wasm"] });
  if (!result.success) throw new AggregateError(result.logs, "Cloudflare Worker build failed");
  await cp(new URL("../engine/build/doom-worker.wasm", import.meta.url), `${outdir}/doom.wasm`);
  return result.outputs[0].path;
}

// SPDX-License-Identifier: GPL-2.0-or-later
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = `${root}apps/host-cloudflare/dist`;
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(`${root}dist`, `${output}/assets`, { recursive: true });
const result = await Bun.build({ entrypoints: [`${root}apps/host-cloudflare/worker.ts`],
  outdir: `${output}/worker`, naming: "worker.js", target: "browser", format: "esm", external: ["cloudflare:workers"] });
if (!result.success) throw new AggregateError(result.logs, "Cloudflare Worker build failed");
console.log(`Cloudflare bundle and assets: ${output}`);

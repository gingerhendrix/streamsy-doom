// SPDX-License-Identifier: GPL-2.0-or-later
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorker } from "./bundle-worker";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = `${root}apps/host-cloudflare/dist`;
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(`${root}dist`, `${output}/assets`, { recursive: true });
await bundleWorker(`${root}apps/host-cloudflare/worker.ts`, `${output}/worker`);
console.log(`Cloudflare bundle and assets: ${output}`);

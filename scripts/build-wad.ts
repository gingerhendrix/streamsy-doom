// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WAD_PART_SIZE, type WadManifest } from "../src/wad";
const root = fileURLToPath(new URL("../", import.meta.url));

export async function buildWad(
  options: { source?: string; output?: string; notices?: string[] } = {},
): Promise<WadManifest> {
  const source = options.source ?? process.env.DOOM_WAD ?? `${root}engine/data/freedoom1.wad`;
  const output = resolve(options.output ?? `${root}dist/wad`);
  // An override's notices must belong to that WAD; don't label it as Freedoom.
  const notices =
    options.notices ??
    (options.source || process.env.DOOM_WAD
      ? []
      : [`${root}engine/data/COPYING.txt`, `${root}engine/data/CREDITS.txt`]);
  const bytes = await Bun.file(source).bytes();
  if (!bytes.length) throw new Error("Empty WAD");
  const noticeBytes = await Promise.all(
    notices.map(async (path) => ({
      name: path.split("/").at(-1)!,
      bytes: await Bun.file(path).bytes(),
    })),
  );
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const manifest: WadManifest = {
    version: 1,
    size: bytes.length,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    parts: [],
    notices: noticeBytes.map((n) => n.name),
  };
  for (let offset = 0; offset < bytes.length; offset += WAD_PART_SIZE) {
    const part = bytes.subarray(offset, offset + WAD_PART_SIZE),
      name = `part-${manifest.parts.length.toString().padStart(3, "0")}.bin`;
    await Bun.write(`${output}/${name}`, part);
    manifest.parts.push({ name, size: part.length });
  }
  for (const notice of noticeBytes) await Bun.write(`${output}/${notice.name}`, notice.bytes);
  // Publish only after every referenced file exists.
  await Bun.write(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (import.meta.main) {
  const manifest = await buildWad({ output: process.argv[2] });
  console.log(
    `WAD: ${manifest.size} bytes, ${manifest.parts.length} parts, SHA-256 ${manifest.sha256}`,
  );
}

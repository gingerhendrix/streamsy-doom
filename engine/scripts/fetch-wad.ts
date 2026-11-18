// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
const target = fileURLToPath(new URL("../data/", import.meta.url));
const version = "0.13.0";
const zipHash = "3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59";
const wadHash = "7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d";
function verify(data: Uint8Array, expected: string) {
  if (new Bun.CryptoHasher("sha256").update(data).digest("hex") !== expected)
    throw new Error("Freedoom SHA-256 mismatch; refusing to use download");
}
if (process.env.DOOM_WAD) {
  const wad = Bun.file(process.env.DOOM_WAD);
  if (!(await wad.exists())) throw new Error(`DOOM_WAD not found: ${wad.name}`);
  console.log(`Using user WAD: ${wad.name}; no download needed (set DOOM_WAD for tests too).`);
} else {
  await mkdir(target, { recursive: true });
  const existing = Bun.file(`${target}/freedoom1.wad`);
  if (await existing.exists()) {
    verify(await existing.bytes(), wadHash);
    console.log("Verified cached Freedoom Phase 1 0.13.0");
  } else {
    const url = `https://github.com/freedoom/freedoom/releases/download/v${version}/freedoom-${version}.zip`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const zip = new Uint8Array(await response.arrayBuffer());
    verify(zip, zipHash);
    const files = unzipSync(zip, {
      filter: (f) => /\/(freedoom1\.wad|COPYING\.txt|CREDITS\.txt)$/.test(f.name),
    });
    const wad = files[`freedoom-${version}/freedoom1.wad`];
    verify(wad, wadHash);
    for (const name of ["freedoom1.wad", "COPYING.txt", "CREDITS.txt"])
      await Bun.write(`${target}/${name}`, files[`freedoom-${version}/${name}`]);
    console.log(`Fetched Freedoom Phase 1 ${version}: ${wad.length} bytes; SHA-256 verified`);
  }
}

// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWad } from "../scripts/build-wad";
import { loadWad, WAD_PART_SIZE } from "../src/wad";
const directory = await mkdtemp(join(tmpdir(), "doom-wad-test-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
test("split at 8 MiB, preserve notices, reconstruct and reject corrupt assets", async () => {
  const source = join(directory, "input.wad"), output = join(directory, "wad");
  const bytes = new Uint8Array(WAD_PART_SIZE + 19).map((_, i) => i % 251);
  await Bun.write(source, bytes);
  const notice = join(directory, "COPYING.txt"); await Bun.write(notice, "test notice");
  const manifest = await buildWad({ source, output, notices: [notice] });
  expect(manifest.parts.map(p => p.size)).toEqual([WAD_PART_SIZE, 19]);
  expect(manifest.notices).toEqual(["COPYING.txt"]);
  expect(await Bun.file(join(output, "COPYING.txt")).text()).toBe("test notice");
  const request = async (url: string) => new Response(Bun.file(join(directory, url)));
  expect(await loadWad("wad/manifest.json", request)).toEqual(bytes);
  await Bun.write(join(output, manifest.parts[1].name), new Uint8Array(19));
  await expect(loadWad("wad/manifest.json", request)).rejects.toThrow("SHA-256 mismatch");
  await Bun.write(join(output, manifest.parts[1].name), new Uint8Array(18));
  await expect(loadWad("wad/manifest.json", request)).rejects.toThrow("part size mismatch");
  await Bun.write(source, new Uint8Array(12));
  await buildWad({ source, output });
  expect(await readdir(output)).toEqual(["manifest.json", "part-000.bin"]);
});
test("reject invalid manifests and HTTP errors", async () => {
  const response = (body: unknown) => async () => Response.json(body);
  await expect(loadWad("/wad/manifest.json", response({ version: 2 }))).rejects.toThrow("Invalid WAD manifest");
  const m = { version: 1, size: 1, sha256: "0".repeat(64), parts: [{ name: "../secret", size: 1 }] };
  await expect(loadWad("/wad/manifest.json", response(m))).rejects.toThrow("Invalid WAD part");
  await expect(loadWad("/wad/manifest.json", async () => new Response(null, { status: 404 }))).rejects.toThrow("HTTP 404");
});

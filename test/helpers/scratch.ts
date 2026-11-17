// SPDX-License-Identifier: GPL-2.0-or-later
import { afterAll } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
/** Retain evidence under an explicit root; otherwise remove the suite's scratch. */
export async function testScratch(label: string) {
  const retained = process.env.DOOM_TEST_SCRATCH;
  const base = retained ? resolve(retained) : tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, `doom-${label}-`));
  if (!retained) afterAll(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

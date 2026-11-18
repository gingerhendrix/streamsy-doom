// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { Streamsy } from "@streamsy/core";
import { Commit, Projection } from "@streamsy/projection";
import { Schema } from "effect";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../../scripts/bundle-worker";
import { testScratch } from "../helpers/scratch";
const root = await testScratch("snapshot-proof");
test("0.12.0 rejects bytes producer output at binding, requiring the approved JSON fallback", () => {
  class Input extends Streamsy.json<Input>()("Proof/BytesInput", "proof/bytes-input", { params: {}, schema: Schema.Number }) {}
  class Bytes extends Streamsy.bytes<Bytes>()("Proof/Bytes", "proof/bytes", { params: {} }) {}
  const output = Projection.emit({ id: "proof-bytes", params: {}, inputs: { input: Input }, outputs: { bytes: Bytes }, commit: Commit.producer,
    emit: () => ({ bytes: [new Uint8Array(600000)] }) });
  expect(() => output.at({})).toThrow("Projection outputs require JSON or state routes");
});
test("workerd topology proof: 600 KB JSON/base64 producer retry and restart; range query gap", async () => {
  const scriptPath = await bundleWorker("test/topology/snapshot-proof-worker.ts", `${root}/bundle`);
  const start = () => new Miniflare({ rootPath: root, modulesRoot: `${root}/bundle`, modules: [{ type: "ESModule", path: scriptPath }], compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], cf: false,
    durableObjects: { GAMES: { className: "ProofGame", useSQLite: true }, REPLAYS: { className: "ProofReplay", useSQLite: true } }, durableObjectsPersist: `${root}/state` });
  let mf = start();
  const stub = async (binding: string, name: string) => { const ns = await mf.getDurableObjectNamespace(binding); return ns.get(ns.idFromName(name)); };
  const rows = async () => { const game = await stub("GAMES", "game:proof"); return await (await game.fetch("https://internal/proof/index/a?offset=-1")).json() as { tic: number; size: number; start: string; end: string }[]; };
  try {
    await mf.ready;
    const game = await stub("GAMES", "game:proof"), replay = await stub("REPLAYS", "replay:a");
    const expiry = new Date(Date.now() + 86400000).toISOString();
    for (const [target, path, type, body] of [[game, "snapshots", "application/json", "[]"], [game, "index", "application/json", "[]"], [replay, "input", "application/json", '[ {"tic":7} ]']] as const)
      { const response = await target.fetch(`https://internal/proof/${path}/a`, { method: "PUT", headers: { "Content-Type": type, "Stream-Expires-At": expiry }, body }); if (!response.ok) throw new Error(await response.text()); }
    let entries: Awaited<ReturnType<typeof rows>> = [];
    for (let n = 0; n < 500; n++) { entries = await rows(); if (entries.length) break; await Bun.sleep(20); }
    expect(entries).toHaveLength(1); expect(entries[0].size).toBe(600000);
    const entry = entries[0];
    const response = await game.fetch(`https://internal/proof/snapshots/a?offset=${entry.start}&endOffset=${entry.end}`);
    const encoded = await response.json() as { tic: number; data: string }[];
    expect(encoded).toHaveLength(1);
    const bytes = Uint8Array.from(atob(encoded[0].data), value => value.charCodeAt(0));
    expect(bytes.length).toBe(600000);
    for (let n = 0; n < bytes.length; n++) if (bytes[n] !== (n + 7) % 251) throw new Error(`Byte mismatch ${n}`);
    expect((await replay.fetch("https://internal/proof/input/a", { method: "POST", headers: { "Content-Type": "application/json" }, body: '[{"tic":8}]' })).ok).toBe(true);
    for (let n = 0; n < 500; n++) { entries = await rows(); if (entries.length === 2) break; await Bun.sleep(20); }
    expect(entries).toHaveLength(2);
    expect(entries.map(row => row.tic)).toEqual([7, 8]);
    expect(entries[1].start).toBe(entries[0].end);
    const accepted = await (await game.fetch("https://internal/__probe")).json() as { posts: number; failed: boolean };
    expect(accepted.failed).toBe(true); expect(accepted.posts).toBeGreaterThanOrEqual(3);
    const range = await game.fetch(`https://internal/proof/snapshots/a?offset=${entry.start}&endOffset=${entry.end}`);
    const rangeItems = await range.json() as { tic: number; data: string }[];
    expect(range.headers.get("Stream-Next-Offset")).toBe(entries[1].end);
    const after = await game.fetch(`https://internal/proof/snapshots/a?offset=${entry.end}`);
    expect((await after.json() as { tic: number }[]).map(row => row.tic)).toEqual([8]);
    // 0.12.0 ignores endOffset. This documents the blocking topology gap.
    expect(rangeItems).toHaveLength(2);
    const invalid = await game.fetch(`https://internal/proof/snapshots/a?offset=${entry.start}..${entry.end}`);
    expect(invalid.status).toBe(400);
    await mf.dispose(); mf = start(); await mf.ready;
    const resumed = await stub("REPLAYS", "replay:a"); await resumed.fetch("https://internal/proof/input/a", { method: "HEAD" });
    await Bun.sleep(300);
    expect(await rows()).toEqual(entries);
    console.log(`MEASURED local workerd topology proof: bytes=${bytes.length}, JSON wire item bytes=${JSON.stringify(encoded[0]).length}, messages after lost response/restart=${entries.length}, accepted append attempts=${accepted.posts}, range returned=${rangeItems.length}, start=${entry.start}, end=${entry.end}`);
  } finally { await mf.dispose(); }
}, 30000);

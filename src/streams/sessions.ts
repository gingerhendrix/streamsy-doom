// SPDX-License-Identifier: GPL-2.0-or-later
import { ProtocolClient, batchPath, binary, concat, encode, offsetOf, sessionPath, uint32 } from "./protocol";
import { familyOf, newSessionId, newForkId, assertForkFamily } from "./ids";
import { Lobby } from "./lobby";
import type { SessionMetadata } from "./v2";
import { SnapshotStore, type Identity, type ReplayEngine } from "./snapshots";
export interface SessionHeader extends Identity { formatVersion: 1; forkedFrom: string | null; forkTic: number | null }
export interface BatchBoundary { startTic: number; endTic: number; before: string; after: string }
interface Manifest { headerOffset?: string; batch?: BatchBoundary }
export class SessionWriter {
  private busy = false;
  private tickCount: number;
  constructor(readonly client: ProtocolClient, public row: SessionMetadata, public offset: string) {
    this.tickCount = row.forkTic ?? 0;
  }
  get tic() { return this.tickCount; }
  async append(frames: Uint8Array[]) {
    if (this.busy) throw new Error("Writer already in use");
    if (!frames.length || frames.some(frame => frame.length !== 9)) throw new Error("Expected nonempty batch of 9-byte frames");
    uint32(this.tic + frames.length);
    this.busy = true;
    try {
      const before = this.offset;
      const response = await this.client.append(sessionPath(this.row.id), concat(frames), binary, { "Stream-Expected-Offset": before });
      this.offset = offsetOf(response);
      const batch = { startTic: this.tic, endTic: this.tic + frames.length, before, after: this.offset };
      this.tickCount = batch.endTic;
      await this.client.append(batchPath(this.row.id), JSON.stringify([{ batch }]), "application/json");
      return batch;
    } finally { this.busy = false; }
  }
  // Drive one engine batch; the server derives snapshots from the appended inputs.
  async record(engine: ReplayEngine, count: number, input: (tic: number) => void = () => {}) {
    if (engine.tic !== this.tic) throw new Error("Engine/writer tic mismatch");
    if (!Number.isInteger(count) || count < 1) throw new Error("Invalid count");
    const frames: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      input(engine.tic); frames.push(engine.step());
    }
    return this.append(frames);
  }
  async end() { await this.client.request(`doom/v2/end/${this.row.id}`, { method: "POST" }); this.row = { ...this.row, ended: true }; }
}
export async function createSession(client: ProtocolClient, options: {
  id?: string; playerName: string; identity: Identity;
}) {
  const id = options.id ?? newSessionId();
  familyOf(id);
  const header: SessionHeader = { ...options.identity, formatVersion: 1, forkedFrom: null, forkTic: null };
  const responseRow = await client.request(`doom/v2/bootstrap/${id}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerName: options.playerName, ...options.identity, forkedFrom: null, forkTic: null }) });
  const row = await responseRow.json() as SessionMetadata;
  const response = await client.create(sessionPath(id), encode(header));
  const offset = offsetOf(response);
  await client.create(batchPath(id), JSON.stringify([{ headerOffset: offset }]), "application/json");
  return new SessionWriter(client, row, offset);
}
export class SessionReader {
  header?: SessionHeader;
  readonly frames: Uint8Array[] = [];
  offset = "-1";
  private cursor?: string;
  private upToDate = false;
  private closed = false;
  constructor(readonly client: ProtocolClient, readonly id: string) {}
  async pull(live = false, signal?: AbortSignal) {
    const before = this.offset;
    const batch = await this.client.read(sessionPath(this.id), before, live, signal, this.cursor);
    let bytes = batch.bytes;
    if (!this.header && bytes.length) {
      const end = bytes.indexOf(10);
      if (end < 0) throw new Error("Missing session header");
      this.header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
      if (this.header?.formatVersion !== 1) throw new Error("Unsupported session format");
      bytes = bytes.subarray(end + 1);
    }
    if (bytes.length % 9) throw new Error("Truncated frame batch");
    const events = [];
    for (let i = 0; i < bytes.length; i += 9) {
      const frame = bytes.slice(i, i + 9); this.frames.push(frame);
      events.push({ tic: this.frames.length, frame, offset: batch.offset });
    }
    this.offset = batch.offset; this.cursor = batch.cursor; this.upToDate = batch.upToDate; this.closed = batch.closed;
    return events;
  }
  async catchUp() {
    do { await this.pull(); } while (!this.upToDate);
    return this;
  }
  async *follow(signal?: AbortSignal) {
    while (!signal?.aborted) {
      for (const event of await this.pull(this.upToDate, signal)) yield event;
      if (this.closed) return;
    }
  }
  async seek(engine: ReplayEngine, target: number) {
    uint32(target); await this.catchUp();
    if (target > this.frames.length) throw new Error("Seek beyond tail");
    for (const [key, value] of Object.entries(engine.identity)) {
      if (this.header?.[key as keyof SessionHeader] !== value) throw new Error(`Session ${key} mismatch`);
    }
    const store = new SnapshotStore(this.client, this.id);
    const entry = (await store.entries()).filter(entry => entry.tic <= target).at(-1);
    if (entry) engine.restore(await store.load(entry));
    else if (engine.tic !== 0) throw new Error("Seek before first snapshot requires a fresh engine");
    for (let i = engine.tic; i < target; i++) engine.step(this.frames[i]);
    return { snapshotTic: entry?.tic ?? 0, replayed: target - (entry?.tic ?? 0) };
  }
}
export async function forkSession(client: ProtocolClient, parentId: string, tic: number, options: {
  id?: string; playerName: string;
}) {
  uint32(tic);
  const id = options.id ?? newForkId(parentId);
  // Validate before bootstrap, lobby initialization, or any protocol PUT.
  assertForkFamily(parentId, id);
  const lobby = new Lobby(client), parent = await lobby.get(parentId);
  const manifest = await client.json<Manifest>(batchPath(parentId));
  const headerOffset = manifest.find(record => record.headerOffset)?.headerOffset;
  if (!headerOffset) throw new Error("Missing header boundary");
  const batches = manifest.flatMap(record => record.batch ? [record.batch] : []);
  if (tic > (batches.at(-1)?.endTic ?? 0)) throw new Error("Invalid fork point");
  const inside = batches.find(batch => batch.startTic < tic && tic < batch.endTic);
  const boundary = tic === 0 ? headerOffset : batches.find(batch => batch.endTic === tic)?.after;
  const offset = inside?.before ?? boundary;
  if (!offset) throw new Error("Missing fork batch boundary");
  const responseRow = await client.request(`doom/v2/bootstrap/${id}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...parent, playerName: options.playerName, forkedFrom: parentId, forkTic: tic }) });
  const row = await responseRow.json() as SessionMetadata;
  const headers: Record<string, string> = { "Stream-Forked-From": `/${sessionPath(parentId)}`, "Stream-Fork-Offset": offset };
  if (inside) headers["Stream-Fork-Sub-Offset"] = String((tic - inside.startTic) * 9);
  const response = await client.create(sessionPath(id), "", binary, 43200, headers);
  const childOffset = offsetOf(response);
  const childBatches = batches.filter(batch => batch.startTic < tic).map(batch => ({
    batch: batch.endTic > tic ? { ...batch, endTic: tic, after: childOffset } : batch,
  }));
  await client.create(batchPath(id), JSON.stringify([{ headerOffset }]), "application/json");
  for (let i = 0; i < childBatches.length; i += 1000)
    await client.append(batchPath(id), JSON.stringify(childBatches.slice(i, i + 1000)), "application/json");
  return new SessionWriter(client, row, childOffset);
}
export async function deleteSession(client: ProtocolClient, id: string) {
  await new Lobby(client).get(id);
  await client.remove(batchPath(id));
  await client.request(`doom/v2/delete/${id}`, { method: "POST" });
}

// SPDX-License-Identifier: GPL-2.0-or-later
import { FRAME_BYTES, validTic } from "./frames";
import { assertForkFamily, newForkId } from "./ids";
import { Lobby } from "./lobby";
import { batchPath, sessionPath } from "./paths";
import { JSON_CONTENT, offsetOf, type ProtocolClient } from "./protocol";
import {
  manifestBody,
  SessionWriter,
  type BatchBoundary,
  type ManifestRecord,
} from "./session-writer";
import { bootstrapOnServer } from "./sessions";

const MANIFEST_RECORDS_PER_APPEND = 1000;

interface ParentManifest {
  headerOffset: string;
  batches: BatchBoundary[];
}

async function readParentManifest(client: ProtocolClient, parentId: string) {
  const records = await client.json<ManifestRecord>(batchPath(parentId));
  const headerOffset = records.find((record) => record.headerOffset)?.headerOffset;
  if (!headerOffset) throw new Error("Missing header boundary");
  const batches = records.flatMap((record) => (record.batch ? [record.batch] : []));
  return { headerOffset, batches } satisfies ParentManifest;
}

function forkHeaders(parentId: string, { headerOffset, batches }: ParentManifest, tic: number) {
  const lastRecordedTic = batches.at(-1)?.endTic ?? 0;
  if (tic > lastRecordedTic) throw new Error("Invalid fork point");
  const batchContainingTic = batches.find((batch) => batch.startTic < tic && tic < batch.endTic);
  const offsetAtBatchBoundary =
    tic === 0 ? headerOffset : batches.find((batch) => batch.endTic === tic)?.after;
  const forkOffset = batchContainingTic?.before ?? offsetAtBatchBoundary;
  if (!forkOffset) throw new Error("Missing fork batch boundary");
  const headers: Record<string, string> = {
    "Stream-Forked-From": `/${sessionPath(parentId)}`,
    "Stream-Fork-Offset": forkOffset,
  };
  if (batchContainingTic) {
    const bytesIntoBatch = (tic - batchContainingTic.startTic) * FRAME_BYTES;
    headers["Stream-Fork-Sub-Offset"] = String(bytesIntoBatch);
  }
  return headers;
}

function batchesInheritedByChild(batches: BatchBoundary[], forkTic: number, childOffset: string) {
  return batches
    .filter((batch) => batch.startTic < forkTic)
    .map((batch) => ({
      batch: batch.endTic > forkTic ? { ...batch, endTic: forkTic, after: childOffset } : batch,
    }));
}

async function writeChildManifest(
  client: ProtocolClient,
  childId: string,
  headerOffset: string,
  inherited: ManifestRecord[],
) {
  await client.create(batchPath(childId), manifestBody([{ headerOffset }]), {
    contentType: JSON_CONTENT,
  });
  for (let start = 0; start < inherited.length; start += MANIFEST_RECORDS_PER_APPEND) {
    const records = inherited.slice(start, start + MANIFEST_RECORDS_PER_APPEND);
    await client.append(batchPath(childId), manifestBody(records), JSON_CONTENT);
  }
}

export async function forkSession(
  client: ProtocolClient,
  parentId: string,
  tic: number,
  options: { id?: string; playerName: string },
) {
  validTic(tic);
  const id = options.id ?? newForkId(parentId);
  assertForkFamily(parentId, id);
  const parent = await new Lobby(client).get(parentId);
  const manifest = await readParentManifest(client, parentId);
  const headers = forkHeaders(parentId, manifest, tic);
  const row = await bootstrapOnServer(client, id, {
    ...parent,
    playerName: options.playerName,
    forkedFrom: parentId,
    forkTic: tic,
  });
  const created = await client.create(sessionPath(id), "", { headers });
  const childOffset = offsetOf(created);
  const inherited = batchesInheritedByChild(manifest.batches, tic, childOffset);
  await writeChildManifest(client, id, manifest.headerOffset, inherited);
  return new SessionWriter(client, row, childOffset);
}

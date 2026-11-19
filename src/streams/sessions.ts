// SPDX-License-Identifier: GPL-2.0-or-later
import { encodeJsonLine } from "./bytes";
import type { SessionMetadata } from "./declarations";
import { SESSION_FORMAT_VERSION } from "./frames";
import { newSessionId, validSessionId } from "./ids";
import { Lobby } from "./lobby";
import { batchPath, bootstrapPath, deletePath, sessionPath } from "./paths";
import { JSON_CONTENT, offsetOf, type ProtocolClient } from "./protocol";
import type { SessionHeader } from "./session-reader";
import { manifestBody, SessionWriter } from "./session-writer";
import type { Identity } from "./snapshots";

export async function bootstrapOnServer(
  client: ProtocolClient,
  id: string,
  session: object,
): Promise<SessionMetadata> {
  const response = await client.request(bootstrapPath(id), {
    method: "POST",
    headers: { "Content-Type": JSON_CONTENT },
    body: JSON.stringify(session),
  });
  return await response.json();
}

export async function createSession(
  client: ProtocolClient,
  options: { id?: string; playerName: string; identity: Identity },
) {
  const id = validSessionId(options.id ?? newSessionId());
  const notForked = { forkedFrom: null, forkTic: null };
  const header: SessionHeader = {
    ...options.identity,
    formatVersion: SESSION_FORMAT_VERSION,
    ...notForked,
  };
  const row = await bootstrapOnServer(client, id, {
    playerName: options.playerName,
    ...options.identity,
    ...notForked,
  });
  const created = await client.create(sessionPath(id), encodeJsonLine(header));
  const headerOffset = offsetOf(created);
  await client.create(batchPath(id), manifestBody([{ headerOffset }]), {
    contentType: JSON_CONTENT,
  });
  return new SessionWriter(client, row, headerOffset);
}

export async function deleteSession(client: ProtocolClient, id: string) {
  await new Lobby(client).get(id);
  await client.remove(batchPath(id));
  await client.request(deletePath(id), { method: "POST" });
}

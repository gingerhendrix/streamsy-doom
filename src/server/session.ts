// SPDX-License-Identifier: GPL-2.0-or-later
import { Transaction } from "@streamsy/projection";
import { Effect } from "effect";
import { failIfGameStreamIsMissing, GameTable } from "../storage/state-tables";
import { Game, type SessionMetadata } from "../streams/declarations";
import { MAX_TIC } from "../streams/frames";
import { assertForkFamily, validSessionId } from "../streams/ids";

const MAX_PLAYER_NAME_LENGTH = 40;
const SKILLS = { min: 1, max: 5 };
const EPISODES = { min: 1, max: 4 };
const MAPS = { min: 1, max: 9 };

export type SessionInput = Omit<SessionMetadata, "id" | "createdAt" | "ended">;
export type SessionChange = "end" | "delete";

const isIntegerWithin = (value: unknown, { min, max }: { min: number; max: number }) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

function validPlayerName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_PLAYER_NAME_LENGTH)
    throw new Error("Invalid playerName (1–40 characters)");
  return name;
}

function validFork(childId: string, forkedFrom: unknown, forkTic: unknown) {
  if ((forkedFrom === null) !== (forkTic === null)) throw new Error("Fork requires parent and tic");
  if (forkedFrom === null) return { forkedFrom: null, forkTic: null };
  if (typeof forkedFrom !== "string") throw new Error("Invalid forkedFrom");
  assertForkFamily(forkedFrom, childId);
  if (!isIntegerWithin(forkTic, { min: 0, max: MAX_TIC })) throw new Error("Invalid forkTic");
  return { forkedFrom, forkTic: forkTic as number };
}

export function parseSessionInput(id: string, input: unknown): SessionInput {
  validSessionId(id);
  if (!input || typeof input !== "object") throw new Error("Expected session metadata");
  const fields = input as Record<string, unknown>;
  const playerName = validPlayerName(fields.playerName);
  const integerField = (name: string, range: { min: number; max: number }) => {
    if (!isIntegerWithin(fields[name], range)) throw new Error(`Invalid ${name}`);
    return fields[name] as number;
  };
  const skill = integerField("skill", SKILLS);
  const episode = integerField("episode", EPISODES);
  const map = integerField("map", MAPS);
  const fork = validFork(id, fields.forkedFrom ?? null, fields.forkTic ?? null);
  return { playerName, skill, episode, map, ...fork };
}

const inOneStorageTransaction = <A, E, R>(readThenWrite: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* (yield* Transaction).withTransaction(readThenWrite);
  });

const storedSession = (id: string) =>
  Effect.gen(function* () {
    yield* failIfGameStreamIsMissing(id);
    const table = GameTable.at({ id });
    yield* table.sync();
    return (yield* table.get("session", id)).value;
  });

const upsertSession = (session: SessionMetadata) => ({
  type: "session" as const,
  key: session.id,
  value: session,
  headers: { operation: "upsert" as const },
});

const deleteSession = (id: string) => ({
  type: "session" as const,
  key: id,
  headers: { operation: "delete" as const },
});

export const bootstrapSession = (id: string, input: SessionInput) =>
  inOneStorageTransaction(
    Effect.gen(function* () {
      const alreadyBootstrapped = yield* storedSession(id);
      if (alreadyBootstrapped) return alreadyBootstrapped;
      const session: SessionMetadata = {
        ...input,
        id,
        createdAt: new Date().toISOString(),
        ended: false,
      };
      yield* (yield* Game).append({ id }, [upsertSession(session)]);
      return session;
    }),
  );

export const changeSession = (id: string, change: SessionChange) =>
  inOneStorageTransaction(
    Effect.gen(function* () {
      const session = yield* storedSession(id);
      if (!session) return false;
      const event =
        change === "delete" ? deleteSession(id) : upsertSession({ ...session, ended: true });
      yield* (yield* Game).append({ id }, [event]);
      return true;
    }),
  );

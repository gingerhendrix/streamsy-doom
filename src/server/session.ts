// SPDX-License-Identifier: GPL-2.0-or-later
import { Effect } from "effect";
import { assertForkFamily, familyOf } from "../streams/ids";
import { Game, type SessionMetadata } from "../streams/v2";
import { Transaction } from "@streamsy/projection";
import { GameTable } from "./state-snapshot";

export function sessionInput(
  id: string,
  input: unknown,
): Omit<SessionMetadata, "id" | "createdAt" | "ended"> {
  familyOf(id);
  if (!input || typeof input !== "object") throw new Error("Expected session metadata");
  const value = input as Record<string, unknown>;
  if (
    typeof value.playerName !== "string" ||
    !value.playerName.trim() ||
    value.playerName.trim().length > 40
  )
    throw new Error("Invalid playerName (1–40 characters)");
  const integer = (key: string, min: number, max: number) => {
    const n = value[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
      throw new Error(`Invalid ${key}`);
    return n;
  };
  const skill = integer("skill", 1, 5),
    episode = integer("episode", 1, 4),
    map = integer("map", 1, 9);
  const forkedFrom = value.forkedFrom ?? null,
    forkTic = value.forkTic ?? null;
  if ((forkedFrom === null) !== (forkTic === null)) throw new Error("Fork requires parent and tic");
  if (forkedFrom !== null) {
    if (typeof forkedFrom !== "string") throw new Error("Invalid forkedFrom");
    assertForkFamily(forkedFrom, id);
    if (
      typeof forkTic !== "number" ||
      !Number.isInteger(forkTic) ||
      forkTic < 0 ||
      forkTic > 0xffffffff
    )
      throw new Error("Invalid forkTic");
  }
  return {
    playerName: value.playerName.trim(),
    skill,
    episode,
    map,
    forkedFrom,
    forkTic: forkTic as number | null,
  };
}
// Lookup and every read-modify-write share the storage transaction on both hosts.
const sessionAt = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Game).head({ id });
    const table = GameTable.at({ id });
    yield* table.sync();
    return (yield* table.get("session", id)).value;
  });
export const readSession = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* Transaction).withTransaction(sessionAt(id));
  });
export const bootstrapSession = (id: string, input: ReturnType<typeof sessionInput>) =>
  Effect.gen(function* () {
    return yield* (yield* Transaction).withTransaction(
      Effect.gen(function* () {
        const existing = yield* sessionAt(id);
        if (existing) return existing;
        const row: SessionMetadata = {
          ...input,
          id,
          createdAt: new Date().toISOString(),
          ended: false,
        };
        yield* (yield* Game).append({ id }, [
          { type: "session", key: id, value: row, headers: { operation: "upsert" } },
        ]);
        return row;
      }),
    );
  });
export const changeSession = (id: string, action: "end" | "delete") =>
  Effect.gen(function* () {
    return yield* (yield* Transaction).withTransaction(
      Effect.gen(function* () {
        const row = yield* sessionAt(id);
        if (!row) return false;
        yield* (yield* Game).append({ id }, [
          action === "delete"
            ? { type: "session", key: id, headers: { operation: "delete" } }
            : {
                type: "session",
                key: id,
                value: { ...row, ended: true },
                headers: { operation: "upsert" },
              },
        ]);
        return true;
      }),
    );
  });

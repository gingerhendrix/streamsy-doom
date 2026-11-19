// SPDX-License-Identifier: GPL-2.0-or-later
const FAMILY_ID_LENGTH = 32;
const INVALID_SESSION_ID = "Invalid v2 session id";

export const sessionIdPattern = /^[0-9a-f]{32}_[0-9a-f]{32}$/;

export const isSessionId = (id: string) => sessionIdPattern.test(id);

export function validSessionId(id: string) {
  if (!isSessionId(id)) throw new Error(INVALID_SESSION_ID);
  return id;
}

export const familyOf = (id: string) => validSessionId(id).slice(0, FAMILY_ID_LENGTH);

const randomPart = () => crypto.randomUUID().replaceAll("-", "");

export const newSessionId = () => `${randomPart()}_${randomPart()}`;

export const newForkId = (parent: string) => `${familyOf(parent)}_${randomPart()}`;

export function assertForkFamily(parent: string, child: string) {
  if (familyOf(parent) !== familyOf(child)) throw new Error("Cross-family fork id");
}

// SPDX-License-Identifier: GPL-2.0-or-later
export const familyIdPattern = /^[0-9a-f]{32}_[0-9a-f]{32}$/;
export const isFamilyId = (id: string) => familyIdPattern.test(id);
export function familyOf(id: string) {
  if (!isFamilyId(id)) throw new Error("Invalid v2 session id");
  return id.slice(0, 32);
}
const randomPart = () => crypto.randomUUID().replaceAll("-", "");
export const newSessionId = () => `${randomPart()}_${randomPart()}`;
export const newForkId = (parent: string) => `${familyOf(parent)}_${randomPart()}`;
export function assertForkFamily(parent: string, child: string) {
  if (familyOf(parent) !== familyOf(child)) throw new Error("Cross-family fork id");
}

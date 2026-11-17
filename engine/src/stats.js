// SPDX-License-Identifier: GPL-2.0-or-later
// Ordered ABI layout returned by _dg_stats(); shared by both engine adapters.
export const statNames = Object.freeze(/** @type {const} */ (["tic", "gamestate", "episode", "map", "leveltime", "playerstate",
  "health", "armor", "kills", "items", "secrets", "totalKills", "totalItems", "totalSecrets", "weapon", "ammo"]));
/** @returns {Record<typeof statNames[number], number>} */
export function readStats(module) {
  const values = new Int32Array(module.HEAPU8.buffer, module._dg_stats(), statNames.length);
  return Object.fromEntries(statNames.map((name, index) => [name, values[index]]));
}

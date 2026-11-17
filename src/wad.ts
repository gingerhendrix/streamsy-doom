// SPDX-License-Identifier: GPL-2.0-or-later
export const WAD_PART_SIZE = 8 * 1024 * 1024;
export interface WadManifest {
  version: 1;
  size: number;
  sha256: string;
  parts: { name: string; size: number }[];
  notices: string[];
}

export async function loadWad(manifestUrl = "/wad/manifest.json", request: typeof fetch = fetch): Promise<Uint8Array> {
  const get = async (url: string) => {
    const response = await request(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`WAD asset ${url}: HTTP ${response.status}`);
    return response;
  };
  const manifest: WadManifest = await (await get(manifestUrl)).json();
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.parts) || !manifest.parts.length)
    throw new Error("Invalid WAD manifest");
  let size = 0;
  const names = new Set<string>();
  for (const part of manifest.parts) {
    if (!/^part-\d+\.bin$/.test(part.name) || names.has(part.name) ||
        !Number.isSafeInteger(part.size) || part.size <= 0 || part.size > WAD_PART_SIZE)
      throw new Error("Invalid WAD part");
    names.add(part.name); size += part.size;
  }
  if (size !== manifest.size) throw new Error("WAD manifest size mismatch");
  const wad = new Uint8Array(size);
  let offset = 0;
  for (const part of manifest.parts) {
    const bytes = new Uint8Array(await (await get(manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1) + part.name)).arrayBuffer());
    if (bytes.length !== part.size) throw new Error(`WAD part size mismatch: ${part.name}`);
    wad.set(bytes, offset); offset += bytes.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", wad);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== manifest.sha256) throw new Error("WAD SHA-256 mismatch");
  return wad;
}

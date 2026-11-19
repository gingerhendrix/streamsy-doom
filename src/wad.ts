// SPDX-License-Identifier: GPL-2.0-or-later
import { sha256Hex } from "./sha256";

export const WAD_PART_SIZE = 8 * 1024 * 1024;

const sha256Pattern = /^[a-f0-9]{64}$/;
const partNamePattern = /^part-\d+\.bin$/;

export interface WadPart {
  name: string;
  size: number;
}

export interface WadManifest {
  version: 1;
  size: number;
  sha256: string;
  parts: WadPart[];
  notices: string[];
}

type AssetRequest = (url: string, init?: RequestInit) => Promise<Response>;

const isPositiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

function assertManifestShape(manifest: WadManifest) {
  const valid =
    manifest.version === 1 &&
    isPositiveSafeInteger(manifest.size) &&
    sha256Pattern.test(manifest.sha256) &&
    Array.isArray(manifest.parts) &&
    manifest.parts.length > 0;
  if (!valid) throw new Error("Invalid WAD manifest");
}

function assertPartsAddUpToManifestSize(manifest: WadManifest) {
  const seenNames = new Set<string>();
  let totalSize = 0;
  for (const part of manifest.parts) {
    const valid =
      partNamePattern.test(part.name) &&
      !seenNames.has(part.name) &&
      isPositiveSafeInteger(part.size) &&
      part.size <= WAD_PART_SIZE;
    if (!valid) throw new Error("Invalid WAD part");
    seenNames.add(part.name);
    totalSize += part.size;
  }
  if (totalSize !== manifest.size) throw new Error("WAD manifest size mismatch");
}

const directoryOf = (url: string) => url.slice(0, url.lastIndexOf("/") + 1);

export async function loadWad(
  manifestUrl = "/wad/manifest.json",
  request: AssetRequest = fetch,
): Promise<Uint8Array> {
  const fetchAsset = async (url: string) => {
    const response = await request(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`WAD asset ${url}: HTTP ${response.status}`);
    return response;
  };

  const manifest: WadManifest = await (await fetchAsset(manifestUrl)).json();
  assertManifestShape(manifest);
  assertPartsAddUpToManifestSize(manifest);

  const wad = new Uint8Array(manifest.size);
  let offset = 0;
  for (const part of manifest.parts) {
    const response = await fetchAsset(directoryOf(manifestUrl) + part.name);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== part.size) throw new Error(`WAD part size mismatch: ${part.name}`);
    wad.set(bytes, offset);
    offset += bytes.length;
  }
  if ((await sha256Hex(wad)) !== manifest.sha256) throw new Error("WAD SHA-256 mismatch");
  return wad;
}

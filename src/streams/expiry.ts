// SPDX-License-Identifier: GPL-2.0-or-later
const STREAM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SLIDING_TTL_SECONDS = 12 * 60 * 60;

const projectionInputPath = /^doom\/v2\/(sessions|batches|replay-wake|events)\//;

export const absoluteExpiry = () => new Date(Date.now() + STREAM_LIFETIME_MS).toISOString();

export function expiryHeadersThatProjectionReadsCannotExtend(path: string): Record<string, string> {
  return projectionInputPath.test(path)
    ? { "Stream-Expires-At": absoluteExpiry() }
    : { "Stream-TTL": String(SLIDING_TTL_SECONDS) };
}

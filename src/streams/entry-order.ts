// SPDX-License-Identifier: GPL-2.0-or-later
import type { EntryRow } from "./declarations";

export const recentFirst = (a: EntryRow, b: EntryRow) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

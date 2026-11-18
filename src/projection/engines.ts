// SPDX-License-Identifier: GPL-2.0-or-later
import { Context } from "effect";
import type { EngineIdentity } from "../../engine/src/engine.js";
import type { HeadlessEngine } from "../../engine/src/headless";
export class ReplayEngines extends Context.Service<ReplayEngines, {
  create(identity: EngineIdentity): Promise<HeadlessEngine>;
  live: Set<string>;
  cache: Map<string, HeadlessEngine>;
}>()("Doom/ReplayEngines") {}

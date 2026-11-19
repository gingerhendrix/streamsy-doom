// SPDX-License-Identifier: GPL-2.0-or-later
import { emptyResponse } from "../../src/server/responses";

export class DoomStreams {
  async fetch(): Promise<Response> {
    return emptyResponse(404);
  }
}

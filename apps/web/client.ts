// SPDX-License-Identifier: GPL-2.0-or-later
import { Lobby, ProtocolClient } from "../../src/streams";

export const client = new ProtocolClient(location.origin);
export const lobby = new Lobby(client);

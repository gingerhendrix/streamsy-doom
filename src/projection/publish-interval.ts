// SPDX-License-Identifier: GPL-2.0-or-later
import { TICS_PER_SECOND } from "../streams/frames";

export const PUBLISH_INTERVAL_TICS = 5 * TICS_PER_SECOND;

export const publishIntervalOf = (tic: number) => Math.floor(tic / PUBLISH_INTERVAL_TICS);

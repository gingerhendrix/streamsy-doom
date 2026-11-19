// SPDX-License-Identifier: GPL-2.0-or-later
import { parseArgs } from "node:util";
import { mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  cleanup,
  runScenario,
  validate,
  summarize,
  type Options,
  type Result,
  type Scenario,
} from "./runner";
import { prepareRecording } from "./recording";
import { ProtocolClient, isSessionId, Lobby } from "../../src/streams";
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  strict: true,
  options: {
    target: { type: "string" },
    scenario: { type: "string", default: "families" },
    players: { type: "string" },
    seconds: { type: "string", default: "30" },
    depth: { type: "string", default: "25" },
    "idle-seconds": { type: "string", default: "180" },
    histories: { type: "string", default: "175,21000" },
    followers: { type: "string" },
    out: { type: "string" },
    cleanup: { type: "string" },
    "long-poll": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "bun run loadtest -- --target <origin> --scenario families|siblings|lineage|cold|lobby --out <scratch/run.json> [--players N --seconds 30 --depth 25 --idle-seconds 180 --histories 175,21000 --followers 3 --long-poll]\nOne families run per ramp: --players 1, then 10, 25, 50. Stops on first failure; always cleans its own IDs. Resume interrupted cleanup: --target <same origin> --cleanup <run.json>. No deploy or forced hosted restart API is used.",
  );
  process.exit(0);
}
if (!values.target) throw new Error("--target is required");
const target = new URL(values.target).origin + "/";
if (values.cleanup) {
  const result = (await Bun.file(values.cleanup).json()) as Result;
  if (
    result.version !== 1 ||
    !/^load-(families|siblings|lineage|cold|lobby)-[0-9a-f-]{36}$/.test(result.run) ||
    result.options.target !== target ||
    !result.ids.every(isSessionId)
  )
    throw new Error("Invalid cleanup journal or target mismatch");
  const deadline = AbortSignal.timeout(60000);
  const client = new ProtocolClient(target, (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]) }),
  );
  const rows = await new Lobby(client).rows();
  if (
    rows.some(
      (row) =>
        result.ids.includes(row.id) && !row.playerName.startsWith(result.run.slice(0, 32) + "-"),
    )
  )
    throw new Error("Journal contains a session owned by another run");
  await cleanup(client, result.ids, result.cleaned);
  result.cleanupResumedAt = new Date().toISOString();
  result.summary = summarize(result);
  await Bun.write(values.cleanup, JSON.stringify(result, null, 2) + "\n");
  console.log(`Cleaned ${result.cleaned.length}/${result.ids.length} journaled sessions`);
  process.exit(0);
}
if (!values.out) throw new Error("--out is required (use the designated scratch folder)");
const scenario = values.scenario as Scenario;
const options: Options = {
  target,
  scenario,
  players: Number(values.players ?? (scenario === "lobby" ? 50 : scenario === "siblings" ? 20 : 1)),
  tics: Math.round(Number(values.seconds) * 35),
  depth: Number(values.depth),
  idleMs: Number(values["idle-seconds"]) * 1000,
  histories: values.histories!.split(",").map(Number),
  followers: Number(values.followers ?? (scenario === "lobby" ? 3 : 1)),
  realtime: true,
  websocket: !values["long-poll"],
  timeoutMs: scenario === "cold" ? 810000 : 720000,
  scoreTimeoutMs: 60000,
};
validate(options);
const needed =
  scenario === "cold"
    ? Math.max(...options.histories) + 175
    : scenario === "lineage"
      ? options.tics + options.depth * 5
      : options.tics + 12;
const recording = await prepareRecording(needed);
const output = resolve(values.out);
await mkdir(resolve(output, ".."), { recursive: true });
if (await Bun.file(output).exists())
  throw new Error("Refusing to overwrite an existing result/journal");
let writes = Promise.resolve();
options.journal = (result) => {
  const data = JSON.stringify(result, null, 2) + "\n";
  writes = writes.then(async () => {
    await Bun.write(output + ".pending", data);
    await rename(output + ".pending", output);
  });
  return writes;
};
const abort = new AbortController();
options.signal = abort.signal;
const stop = () => abort.abort(new Error("Interrupted; cleaning generated sessions"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(
  `Starting ${scenario}: ${scenario === "cold" ? options.histories.length : scenario === "siblings" ? options.players + 1 : options.players} players, ${options.tics} tics; journal ${output}`,
);
const result = await runScenario(options, recording);
console.log(
  JSON.stringify(
    { outcome: result.outcome, failure: result.failure, summary: result.summary },
    null,
    2,
  ),
);
process.exitCode = result.outcome === "passed" ? 0 : 1;

// SPDX-License-Identifier: GPL-2.0-or-later
// Optional read-only analytics companion. Never creates or refreshes tokens.
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Result } from "./runner";
const { values, positionals } = parseArgs({ args: process.argv.slice(2).filter(a => a !== "--"), allowPositionals: true, options: {
  profile: { type: "string", default: "default" }, worker: { type: "string", default: "streamsy-doom-test" },
} });
if (!positionals.length) throw new Error("Usage: bun scripts/loadtest/analytics.ts [--profile default --worker streamsy-doom-test] <scratch/run.json> ...");
if (!/^[a-zA-Z0-9_-]+$/.test(values.profile!)) throw new Error("Invalid profile name");
const file = Bun.file(`${homedir()}/.alchemy/profiles/${values.profile}/cloudflare.json`);
const profile = await file.exists() ? (await file.json()).values : undefined;
const token = process.env.CLOUDFLARE_API_TOKEN ?? profile?.access ?? profile?.apiToken;
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? profile?.accountId;
const source = process.env.CLOUDFLARE_API_TOKEN ? "existing environment API token" : "existing Alchemy profile credential";
const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() as any };
};
for (const input of positionals) {
  const run = await Bun.file(input).json() as Result;
  if (run.version !== 1 || !run.endedAt) throw new Error("Analytics requires a completed run journal");
  const out = resolve(dirname(input), input.split("/").at(-1)!.replace(/\.json$/, "-analytics.json"));
  if (!token || !account) {
    await Bun.write(out, JSON.stringify({ measured: false, reason: "No existing Cloudflare credential/account available; CPU and memory not measured" }, null, 2));
    continue;
  }
  const namespacesResponse = await request(`accounts/${account}/workers/durable_objects/namespaces`);
  const namespaces = namespacesResponse.body.result?.filter((n: any) => n.script === values.worker) ?? [];
  if (!namespaces.length) throw new Error("Cannot resolve test Worker namespaces with existing credentials");
  const filter = `datetime_geq:${JSON.stringify(run.startedAt)},datetime_leq:${JSON.stringify(run.endedAt)}`;
  const query = `{viewer{accounts(filter:{accountTag:${JSON.stringify(account)}}){
    invocations:durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{${filter},scriptName:${JSON.stringify(values.worker)}}){
      dimensions{namespaceId type status} sum{requests errors wallTime} quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 wallTimeP50 wallTimeP95 wallTimeP99}}
    periodic:durableObjectsPeriodicGroups(limit:1000,filter:{${filter},namespaceId_in:${JSON.stringify(namespaces.map((n: any) => n.id))}}){
      dimensions{namespaceId} quantiles{memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}
      sum{cpuTime duration activeTime exceededCpuErrors exceededMemoryErrors fatalInternalErrors rowsRead rowsWritten}}
  }}}`;
  const response = await request("graphql", { method: "POST", body: JSON.stringify({ query }) });
  await Bun.write(out, JSON.stringify({ fetchedAt: new Date().toISOString(), start: run.startedAt, end: run.endedAt, credentialSource: source,
    units: { cpuTime: "microseconds", wallTime: "microseconds", activeTime: "microseconds", duration: "GB*s", memoryUsageBytes: "bytes (isolate, not per engine)" },
    caveat: "Account telemetry may be sampled, delayed, and include other traffic to these classes in the same window. Empty results do not prove zero usage. Re-run after ingestion.",
    namespaces, response }, null, 2) + "\n");
  console.log(`Analytics saved: ${out}; HTTP ${response.status}; GraphQL errors: ${JSON.stringify(response.body.errors)}`);
}

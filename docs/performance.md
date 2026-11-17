# V2 Cloudflare performance — 2026-11-17

**Hosted testing stopped on a Worker failure.** Independent families passed the
1/10/25/50-player ramp, 20 sibling forks passed, and a depth-25 lineage replayed
correctly. The subsequent 50-player, three-follower lobby run returned HTTP 500 /
Cloudflare 1101 on a manifest append. The cold scenario is implemented and locally
tested, but **hosted cold measurements were not run**, following the batch stop rule.
No deployment or application/package fix was made.

Target: `https://streamsy-doom-test.gingerhendrix.workers.dev`, deployed source
`80e745e7a8f29d2a824a78c90c0716453d688fef`. Measurements below are from one Bun
1.4.2 client on this machine, over its existing network connection. These are short,
single runs, with synchronized copies of one scripted E1M1 recording, not capacity
or availability guarantees. Client checks also ran during portions of testing.

The [harness instructions](../scripts/loadtest/README.md) document commands,
limits, cleanup recovery, and optional analytics. Example:

```sh
bun run loadtest -- --target https://streamsy-doom-test.gingerhendrix.workers.dev --scenario families --players 10 --seconds 30 --out /path/to/scratch/families-10.json
```

## Method

The browser's shared clients perform bootstrap, stream creation, expected-offset
frame writes, manifest writes, opaque-offset/sub-offset forks, and State deletion.
A real engine precomputes valid input frames; a headless engine independently
checks the recording. Playback is configured at 35 tics/s with five-tic batches,
coalescing behind slow writes. The cold scenario also seeds and resumes at that cadence. No synthetic player uploads heap snapshots.

Score following uses HTTP catch-up, then `streamsy-live.v1` WebSockets, with the
browser's long-poll fallback. All hosted score followers upgraded successfully;
the lobby run also opened three metadata WebSockets. Score tics are matched to
frame POSTs. Inherited rows and suppressed publications are excluded from live
latency samples. Idle publications are reported separately. Percentiles use nearest
rank. A score row is not a sink HTTP POST: one producer request can contain many rows.

Every latency triplet below is **measured p50/p95/p99 in milliseconds**. Send→score
means client send to score receipt, including both alarms, replay, lobby delivery,
and network. Exact server commit time and individual alarm-hop times are not exposed.
Append+manifest includes both serialized POSTs. No clock synchronization is assumed.

## Hosted measurements

| Run | Bootstrap ms | Frame POST RTT ms | Append+manifest ms | Send→live score ms | Matched live rows | Score rows/s |
| --- | --- | --- | --- | --- | ---: | ---: |
| families-1 | 467/467/467 | 138/186/232 | 268/390/583 | 324/423/475 | 26 | 2.5 |
| families-10 | 544/647/647 | 108/192/282 | 213/333/430 | 302/487/624 | 720 | 23.6 |
| families-25 | 529/721/765 | 106/195/299 | 208/346/513 | 617/1174/1367 | 1800 | 58.0 |
| families-50 | 662/771/831 | 101/171/265 | 201/317/419 | 1046/1727/2073 | 3600 | 114.4 |
| siblings-20 | 598/757/944 | 89/189/247 | 183/314/417 | 8669/19669/21488 | 1020 | 43.2 |
| lineage-25 | 473/700/744 | 77/131/157 | 158/240/265 | 303/520/720 | 22 | 13.9 |
| lobby-50 **aborted** | 965/1209/1377 | 97/179/260 | 193/325/418 | 1736/2698/3002 | 2326 | 112.0 |

Rates are **measured unique primary-follower score rows / active-window seconds**,
including inherited and presence rows if delivered within that window. They measure
application publications, not SQL write load. Family playback was configured for
10 seconds at N=1 and 30 seconds at N=10/25/50. Siblings played for 20 seconds,
starting at tic 7 of a 12-tic parent batch. The lineage seeded 175 tics, then added
five tics per fork. The lobby run aborted after a **measured 20.773-second active
window**; its statistics are partial and cannot support a sustained-load claim.

A frame commit lies between send and acknowledgement. Subtracting those two
endpoints from score receipt gives **inferred bounds on commit→client-observation
percentiles**, based on measured timestamps, in milliseconds:

| Run | p50 lower–upper | p95 lower–upper | p99 lower–upper |
| --- | --- | --- | --- |
| families-1 | 180–324 | 285–423 | 333–475 |
| families-10 | 183–302 | 372–487 | 484–624 |
| families-25 | 494–617 | 1035–1174 | 1223–1367 |
| families-50 | 937–1046 | 1618–1727 | 1970–2073 |
| siblings-20 | 8582–8669 | 19528–19669 | 21342–21488 |
| lineage-25 | 203–303 | 447–520 | 660–720 |
| lobby-50, partial | 1627–1736 | 2591–2698 | 2893–3002 |

The **measured** signed delay of the two extra lobby score followers relative to
follower zero was **0/10/67 ms**, across **4,752 matched observations**. This is
relative delivery difference, not server-to-browser latency.

The sibling result exposes a substantial shared-family delay despite fast appends.
Shared-owner work is a plausible explanation (**inferred**, not isolated here);
there is no server timing evidence establishing which alarm or read caused it.

## Fork depth and cold history

These are **measured single fork-creation samples**, including bootstrap,
manifest/snapshot-index work, and metadata publication; not isolated storage calls.

| Child depth | Fork create ms |
| ---: | ---: |
| 1 | 1073 |
| 5 | 1180 |
| 10 | 1055 |
| 15 | 977 |
| 20 | 1068 |
| 25 | 1170 |

The deepest child's **measured 300-tic** stream read took **60 ms**; local headless
replay took **4 ms** and verified every frame. This local replay time is not hosted
CPU. Five lineage idle-score observations had **measured 30,152 ms p50** and
**30,318 ms p95**, consistent with the configured 30-second idle publication timer.
They are excluded from the live-latency table.

| Cold history | Hosted rebuild latency | Status |
| ---: | --- | --- |
| 175 tics | Not measured | Stopped before cold run |
| 21,000 tics / configured 10-minute history | Not measured | Stopped before cold run |

The harness defaults to a 180-second quiet interval, observes idle engine release,
then resumes. The public API cannot force or confirm a DO restart. Local tests
force an actual workerd process restart using persisted SQLite state. Hosted idle
engine release must not be described as confirmed object eviction; see Cloudflare's
[lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

## Failure evidence and telemetry limits

At **measured 18:55:01.064 UTC**, the lobby run's manifest POST returned HTTP 500,
error 1101, Ray ID `a5c0f27f5869ef3e`. The harness canceled every writer, without
retrying ambiguous frame/manifest appends. There were **zero observed workload
errors** in the six preceding runs. The failing run captured **one workload 500**;
cleanup later failed for **two session IDs**. Additional cleanup errors were found
in server logs, so this is not an exact count of all cleanup HTTP failures.
No workload response recorded 1102, 409, 413, or 429.

A read-only [Workers Observability query](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
returned the failing request's `Network connection lost.` message, followed by
`DoomGames` messages: `Durable Object storage operation exceeded timeout which caused object to be reset.`
Later records contain platform internal-error references and inactive replay-object
connection errors. These are **measured log observations**, not proof of an
application bug, a memory limit, or a causal effect of extra followers. There was
no application stack trace establishing a safe fix. Further hosted load stopped.

Existing Alchemy profile `default` OAuth credentials successfully accessed GraphQL
and resolved all four class namespaces. No token was created/refreshed or committed.
Early queries returned only legacy telemetry; the final retry at **measured
19:00:01–19:00:11 UTC** returned v2 data. The table gives **measured Cloudflare-reported
aggregates/estimates** for each full run window (including bootstrap and cleanup).
Games/Replay/Lobby mean `DoomGames`/`DoomReplay`/`DoomLobby`. N/M means **not measured**:
a missing periodic sample is not zero CPU or memory. Adaptive sampling, periodic
emission boundaries, and other activity in those namespaces limit attribution.
Wall sums include overlapping invocations and idle alarms, so they can exceed run
duration; they do not measure either alarm's delivery delay. Memory is sampled isolate
usage, not a per-engine allocation or an independent peak-memory measurement.

| Run | Class | Reported CPU sum, s | Invocation wall sum, s | Isolate memory p95, MiB |
| --- | --- | ---: | ---: | ---: |
| families-1 | Games | N/M | 7.723 | N/M |
| families-1 | Lobby | 0.711 | 11.832 | 10.4 |
| families-1 | Replay | 1.533 | 8.354 | 78.3 |
| families-10 | Games | 21.747 | 155.601 | 44.3 |
| families-10 | Lobby | 11.641 | 5.812 | 31.2 |
| families-10 | Replay | 6.865 | 143.299 | 90.6 |
| families-25 | Games | 24.292 | 505.295 | 44.6 |
| families-25 | Lobby | N/M | 191.381 | N/M |
| families-25 | Replay | 17.986 | 843.356 | 90.6 |
| families-50 | Games | 58.296 | 876.893 | 43.9 |
| families-50 | Lobby | N/M | 494.216 | N/M |
| families-50 | Replay | 53.077 | 1746.699 | 106.9 |
| siblings-20 | Games | N/M | 58.318 | N/M |
| siblings-20 | Lobby | N/M | 38.486 | N/M |
| siblings-20 | Replay | 4.121 | 29.802 | 87.8 |
| lineage-25 | Games | N/M | 15.898 | N/M |
| lineage-25 | Lobby | N/M | 1.995 | N/M |
| lineage-25 | Replay | 7.784 | 16.800 | 71.1 |
| lobby-50 | Games | 29.344 | 883.597 | 36.6 |
| lobby-50 | Lobby | 18.647 | 692.909 | 36.8 |
| lobby-50 | Replay | 25.409 | 1720.468 | 79.3 |

The available periodic samples reported **measured zero CPU-limit and memory-limit
exceedances**. The aborted lobby window reported **one fatal internal error** for
Games. Invocation status groups also report `clientDisconnected` (including many
family alarms), `scriptThrewException`, and `internalError`; all groups and counts
are retained in raw analytics, separate from client-observed HTTP errors.
The lobby's periodic SQL counter reported **6,321 rows written** in families-10
and **13,225** in the aborted lobby run. These include lifecycle and cleanup work;
they are not steady-state score publication rates. Other lobby periodic cells were
missing. Replay CPU here covers all replay-object work in a window, not isolated
cold-rebuild CPU, which remains unmeasured on the host.

## Cleanup, artifacts, and checks

**Measured:** seven hosted runs created **183 sessions**, peaking at **50 synthetic
players**. Summed run duration including first cleanup attempts was **386.484
seconds**; the longest run was **134.121 seconds**. Runs occurred between
**18:48:13 and 18:56:50 UTC**, with only cleanup/verification and read-only telemetry
after the failure. All synthetic names start with `load-`.

Cleanup retry removed the two remaining sessions. Verification at **18:59:35 UTC**
found **zero synthetic lobby rows**, **183 journaled cleanups**, and HTTP 404 for
both retried sessions' frames, manifests, and indexes. Cleanup uses browser State
row/index/manifest deletion, then additionally removes its own frame streams in
child-before-parent order. Public APIs cannot delete server-owned scores/wakes or
replay identity/checkpoint records; those retain the application's existing policy.
No unrelated session was deleted.

Raw run JSON, logs, `*-analytics.json`, `error-logs.json`,
`error-log-summary.json`, and `cleanup-verification.json` are in:
`/home/gareth/Documents/Personal/scratch/2026-11-17-doom-cross-object-build/batch4/`.
Derived summaries were recomputed from unchanged timestamp observations to exclude
idle rows. `lobby-50.json` retains its failure and records the successful cleanup
retry; the original failure/cleanup errors remain available. Raw files are not committed.

Validation: **passed** `bun run build:cf`, then `bun run typecheck`, then
`bun run test` (**measured 45 pass, zero failures, 94.77 seconds**).
The fast local workerd test covers every scenario, real-time pacing, both live
transports, persisted restart, deepest-child replay, partial-create cleanup,
unrelated-session preservation, and idle/live metric separation. Hosted cold
performance and missing v2 telemetry cells remain outstanding for the coordinator.

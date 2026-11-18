# Per-game topology Cloudflare performance — 2026-11-18

The families ramp (1, 10, 50), 20 sibling forks, and the 50-player lobby with
three Game followers per player all **passed with zero recorded client errors**.
Cold with both default histories also **passed**. No deployment, application
change, or harness fix was made.
The 2026-11-17 measurements below are retained.

Target: `https://streamsy-doom-test.gingerhendrix.workers.dev`; coordinator-reported
deployed source `6ecb61fbc6703c1fa3b771ce9c01195b8d20f110`. The client worktree
was at that same source SHA. This topology follows per-game `Game` streams for
HUD updates, derives `Entries` and the capped `Leaderboard`, reads State snapshots,
and configures `frameWake` concurrency to eight. The replay engine can recover
from its latest server snapshot. These are single runs from Bun 1.4.2 on this
machine and its existing network, with copies of one deterministic E1M1 recording.
They measure these workloads, not capacity or an availability guarantee.

## Method and hosted measurements

Runs were strictly sequential, with independent cleanup verification before the
next workload. All non-cold playback used `--seconds 30`; families used `--players
1`, `10`, then `50`; siblings used `--players 20` (plus one parent); lobby used
`--players 50 --followers 3`. Cold used its default `--histories 175,21000` and
`--idle-seconds 180`. No local tests ran during hosted load. The harness paced
uploads at 35 tics/s, started with five-tic batches, and coalesced behind slow
writes. Game followers upgraded from HTTP catch-up to WebSockets; the Leaderboard
used snapshot-then-follow. All run JSON and logs are retained in scratch.

Every value in the following tables is **measured**, except cells explicitly
marked not measured. Triplets are nearest-rank **p50/p95/p99**, in milliseconds
unless the column says tics. `hudLatencyMs` is frame-send to qualifying live Game
observation; `lobbyDeliveryMs` is frame-send to a qualifying live Leaderboard row
at that source tic. Neither is an isolated server alarm or replay latency.
Staleness samples the last received Leaderboard tic after each append and includes
the intentional 175-tic publication cap. Age is measured from sending the batch
containing that received tic, only when a source batch is known.

| Run | Frame POST RTT ms | HUD latency ms | Lobby delivery ms | Lobby staleness tics | Lobby staleness ms | Score rows/s | Client error records |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
| families-1 | 123/170/204 | 157/414/529 | 439/443/443 | 96/174/180 | 2804/5083/5285 | 2.11 | 0 |
| families-10 | 82/146/231 | 197/382/451 | 494/687/733 | 99/177/186 | 2944/5144/5447 | 21.47 | 0 |
| families-50 | 97/171/249 | 226/430/526 | 731/1047/1161 | 106/186/198 | 3201/5431/5799 | 100.65 | 0 |
| siblings-20 | 89/161/251 | 374/835/1100 | 735/1265/1380 | 234/621/707 | 4754/15736/19424 | 8.96 | 0 |
| lobby-50 | 93/157/230 | 191/393/477 | 577/868/910 | 103/182/194 | 3082/5310/5659 | 105.60 | 0 |
| cold, seed + probes | 84/134/206 | 142/343/487 | 431/787/3399 | 101/179/191 | 2994/5257/7723 | Not measured | 0 |

The cold row aggregates history upload and both resume probes: **measured 325
HUD samples and 125 lobby delivery samples**. Its staleness includes the idle
interval, and it has no active-window rows/s measurement. It does not isolate
cold recovery; see the probe results below.

Observed primary-follower score rows/s counts unique `(id,tic,live)` observations
in each active window, including inherited rows arriving in that window; it does
not count sink POSTs, SQL writes, every internal stats row, or every input tic.
The live latency sample counts were **measured** 64, 661, 3090, 262 and 3230 for
the five non-cold rows above. Lobby delivery sample counts were **measured** 5,
58, 255, 68 and 257 respectively. Sparse, coalesced or unobserved intermediate
states are absent from latency percentiles. Bootstrap and append+manifest
percentiles, all sample counts and transport transitions remain in raw JSON.
The lobby's two extra Game followers had **measured** signed delivery difference
from follower zero of **0/6/12 ms**, across **6560 observations**; this is relative
delivery difference, not server-to-browser latency.

## Comparison and remaining sibling stalls

**Measured comparison:** families-50 HUD p50/p95 was **226/430 ms**, against the
2026-11-17 send-to-score result of **1046/1727 ms**. Siblings delivered-row HUD
p50/p95 was **374/835 ms**, against **8669/19669 ms**. The current lobby run
completed, whereas the baseline lobby run aborted with HTTP 500/1101. The old
send-to-score path included shared lobby score delivery; the new HUD path follows
Game. Baseline families-1 ran for ten seconds and siblings for twenty seconds,
versus thirty seconds here. These are observed cross-run differences; attributing
them specifically to topology or wake concurrency is **inferred**, not isolated
by these runs.

**Measured qualification:** sibling lobby staleness p95 was **621 tics / 15736
ms**, and consecutive live Game observations per session had **15794 ms p95**
and **18962 ms maximum** inter-arrival gaps (257 gaps; after each session's first
observation). Families-50 and lobby-50 inter-arrival p95 was **967 ms** and **919
ms** respectively. The sibling active-window rate was **8.96 rows/s**, versus the
baseline's **43.2 rows/s** under its different duration/path. Low delivered-row
latency does not establish smooth sibling updates or absence of backlog. The
175-tic cap is not an observed upper bound on lobby staleness. The public metrics
do not establish where intermediate progress was delayed or coalesced.

## Cold history and replay telemetry

| History tics | Paced 175-tic probe to caught-up score ms | First probe POST to first qualifying Game row ms | Probe frame POST ms | Probe HUD ms | HUD samples |
| ---: | ---: | ---: | --- | --- | ---: |
| 175 | 5348 | 1430 | 91/157/306 | 114/487/487 | 9 |
| 21000 | 5246 | 5044 | 97/125/153 | 105/105/105 | 1 |

The long-history probe produced only one matched live HUD observation; its repeated
percentile value is one sample, not a latency distribution. First-observation
delay includes waiting for a qualifying publication, not just recovery work.

**Measured:** the read-only snapshot index at **15:00:00 UTC** returned a
**21000-tic, 594512-byte** snapshot for the long-history session and an empty
index for the 175-tic session. This check added two index GETs during the no-input
interval. The default quiet wait was 180 seconds after both histories finished;
the short-history session had already been idle while the long history uploaded.
The harness observed idle presence before probing both sessions, then verified
their resumed scores. The paced probe duration includes uploading 175 tics at
35 tics/s and score delivery. Probe HUD and first-observation latencies also
include network and scheduling, rather than isolated restore time.

**Inferred:** given the deployed recovery code and persisted snapshot, the
long-history cache-miss recovery can restore at tic 21000 instead of replaying its
entire prefix. The public API exposes neither an engine-restore trace nor a forced
DO restart; actual restore execution and object eviction are **not measured**.
There is no hosted cold baseline from 2026-11-17, which stopped before that run,
so no measured cross-release cold speedup can be claimed.

Read-only `bun scripts/loadtest/analytics.ts --profile default <run.json>` used
existing Alchemy credentials without creating or refreshing a token. Each window
was queried initially and retried after ingestion; both versions are retained.
The latest fetches were **measured 15:03:17–15:04:55 UTC**. All three replay windows
returned periodic CPU and memory data. The table contains **measured
Cloudflare-reported sampled aggregates/estimates**, for each complete run window,
including setup, idle time and cleanup. CPU p95 remains separated by invocation
type/status; percentiles are not combined across groups. CPU sums are periodic
counters, not isolated engine step or cold-restore CPU. Memory is sampled isolate
usage, not per-engine allocation or a measured peak.

| Run | Replay CPU sum, s | Successful alarm CPU p95, ms | Successful HTTP CPU p95, ms | Isolate memory p95, MB / MiB |
| --- | ---: | ---: | ---: | ---: |
| families-50 | 272.941 | 38.250 | 24.880 | 152.79 / 145.71 |
| siblings-20 | 32.117 | 65.485 | 36.250 | 133.19 / 127.02 |
| cold | 82.801 | 21.537 | 16.680 | 126.74 / 120.87 |

MB is decimal bytes / 1000000; MiB is bytes / 1048576. Cloudflare documents a
[128 MB per-isolate memory limit, including WASM](https://developers.cloudflare.com/workers/platform/limits/#memory).
The families-50 estimate exceeds both 128 MB and 128 MiB; siblings is near that
reference (**133189550 bytes**), and cold is below both. These observations do
**not** demonstrate safe memory headroom. All available periodic samples returned
**measured zero** CPU-limit, memory-limit and fatal-internal-error counters; zero
reported limit errors does not turn sampled memory into a guaranteed bound.

The baseline families-50 replay CPU sum was **measured 53.077 s** and memory p95
**106.9 MiB**, versus the new **272.941 s / 145.71 MiB**. Baseline siblings was
**4.121 s / 87.8 MiB**, versus **32.117 s / 127.02 MiB** here. Those are
higher reported aggregates in the new windows, with different sampled coverage
and sibling duration; a per-tic CPU regression or its cause is **not isolated**.
Other same-class traffic, sampling, periodic emission boundaries and ingestion
limit attribution. Ingestion materially changed the early family/sibling CPU
and memory estimates; the table uses the retries.

Replay invocation telemetry also reports disconnect status groups: families-50
24 alarm/clientDisconnected, 50 http/responseStreamDisconnected; siblings-20
19 alarm/clientDisconnected, 21 http/clientDisconnected; cold 3
alarm/clientDisconnected, 2 http/clientDisconnected.
These sampled invocation status counts are separate from the **measured zero
client workload/cleanup error records**. All status groups, namespaces and raw
counters are retained; a disconnect status is not proof of an application fault.

## Cleanup, evidence, and checks

**Measured:** all six workloads passed on their first attempt, with **zero
recorded client errors**, **134 journaled sessions cleaned**, and at most **50
synthetic players** in a run. No workload retry or cleanup resume was needed.
The longest run was **793.025 seconds**, below the fifteen-minute limit; summed
run durations were **1012.990 seconds**. Each next workload began after cleanup
verification.
Every value in this cleanup table is **measured**:

| Run | Start UTC | Duration including cleanup, s | Cleaned / journaled | Independent cleanup verified UTC |
| --- | --- | ---: | ---: | --- |
| families-1 | 14:43:45.362 | 33.815 | 1/1 | 14:44:26.512 |
| families-10 | 14:44:32.915 | 36.892 | 10/10 | 14:45:18.233 |
| families-50 | 14:45:26.542 | 55.159 | 50/50 | 14:46:34.977 |
| siblings-20 | 14:46:48.993 | 40.864 | 21/21 | 14:47:42.738 |
| lobby-50 | 14:47:56.604 | 53.235 | 50/50 | 14:49:07.322 |
| cold | 14:49:14.857 | 793.025 | 2/2 | 15:02:36.185 |

Independent read-only checks confirmed frame and manifest HEAD **404**, no session
row in each Game snapshot, empty server snapshot indexes, and no journaled IDs
remaining in the Leaderboard. No unrelated sessions were deleted. Server-owned
Game/stats/presence/wake and replay identity/checkpoint records have no public
delete API and retain their existing policy. The local artifact audit passed all
ordering, duration, player-cap, cleanup and observed-score-verification assertions.

Artifacts are in
`/home/gareth/Documents/Personal/scratch/2026-11-18-doom-topology-build/perf/`:
run JSON/logs, initial and retried `*-analytics*.json`, per-run
`*-cleanup-verification.json`, `summary.json`, `game-observation-gaps.json`, `cold-probes.json`,
`cold-snapshot-evidence.json`, `validation.json`, and
helper scripts. Raw files and generated WASM/WAD/build output are not committed.
Only this report is changed. No Streamsy source/package, remote, deployment, or
hosting configuration was changed.

Validation **passed**: `bun install --frozen-lockfile`, `bun run fetch-wad`,
`bun run build:cf`, then `bun run typecheck`, then `bun run test` (**measured 71
pass, zero failures, 142.57 seconds**). No harness change or new test was needed;
the existing real-workerd harness test covers every scenario and cleanup.

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

These measurements predate server-made snapshots. The current replay projection
writes gzip BLOBs to its own SQLite table every 21,000 tics; the browser reads a
snapshot list and one tic through GET/HEAD-only endpoints. Snapshot/index browser
writes and snapshot fork streams have been removed. Snapshot-time CPU, memory
and sibling-fork lag need fresh hosted measurements before comparing releases.

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

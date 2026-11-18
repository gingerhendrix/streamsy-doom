# V2 hosted load harness

Run `bun install --frozen-lockfile`, `bun run fetch-wad`, and `bun run build:cf` first.
The CLI requires an explicit target and scratch output file. It never deploys.

```sh
bun run loadtest -- --target https://streamsy-doom-test.gingerhendrix.workers.dev --scenario families --players 10 --seconds 30 --out /path/to/scratch/families-10.json
```

Run workloads sequentially. The families ramp is four invocations with `--players 1`,
`10`, `25`, then `50`. Other scenarios:

| Scenario | Defaults / useful options | Work |
| --- | --- | --- |
| siblings | `--players 20 --seconds 30` | Parent seed of 12 tics; every sibling forks inside that batch at tic 7, then plays concurrently |
| lineage | `--depth 25 --seconds 5` | Seed, then fork each previous tail and play five more tics; read and locally replay the deepest child |
| cold | `--histories 175,21000 --idle-seconds 180` | Real-time history upload; idle, then play 175 tics and wait for qualifying score |
| lobby | `--players 50 --seconds 30 --followers 3` | Independent players plus followers of each Game plus the capped Leaderboard stream |

Normal playback runs at 35 tics/s, starting with five-tic batches and coalescing pending
tics when writes are slow, like the browser queue. Cold history setup and its 175-tic
probe also use that cadence; the default long-history run takes about 13 minutes. All frames come from one deterministic
real-engine capture, independently checked by the headless replay engine. No client
heap snapshots are used. Bootstrap, expected-offset appends, manifests, opaque fork
offsets/sub-offsets, and State deletion use the browser's shared stream client.

The harness caps players at 50 (49 sibling children plus parent), chain depth at 49,
workload time at 13.5 minutes (12 minutes outside cold) and cleanup at one minute. It cancels writers on the
first failure, waits for in-flight work, and cleans only IDs journaled before creation.
SIGINT/SIGTERM also run cleanup. A partial create is cleaned even without a lobby row.
Cleanup removes the manifest, State session row, and finally the frame
stream, in child-before-parent order. Browser deletion normally retains frames until
expiry; the harness additionally deletes its own frames, which lets replay clear
its snapshot rows. Server-owned Game/wakes and replay identity/checkpoint
records have no public delete API and retain their existing policy. Session deletes asynchronously remove the derived Leaderboard row.

An interrupted cleanup can be resumed from the same journal:

```sh
bun run loadtest -- --target https://streamsy-doom-test.gingerhendrix.workers.dev --cleanup /path/to/scratch/families-10.json
```

Each synthetic player follows its own Game (one socket per player with the default one follower). A separate Leaderboard follower observes the lobby. The lobby uses `followState` (snapshot then follow); Game followers use `followJson`: HTTP catch-up, `streamsy-live.v1`
WebSockets, then long-poll fallback (`--long-poll` forces it). Batches are applied
only at socket control frames. The harness deduplicates catch-up/reconnect deliveries.
Additional followers measure signed delivery difference relative to follower zero;
this is not server-to-browser latency. Raw JSON includes transport transitions.

Metrics use one client's wall clock. Each score tic is paired with the batch containing
that tic, excluding inherited rows. Only sparse qualifying publications are sampled;
unpublished tics are not counted as lost deliveries. A frame commit occurs between
request send and acknowledgement. Those endpoints bound commit-to-client-observation
latency; neither individual alarm hop nor exact server commit time is exposed publicly.
Reported `hudLatencyMs` (also retained as `sendToScoreMs`) includes the POST network leg, alarms, replay, local Game write and HUD delivery. `lobbyDeliveryMs` pairs summary receipt with its source tic. `lobbyStalenessTics` samples the last received Leaderboard tic after each frame/manifest append; `lobbyStalenessMs` is its age since sending that tic’s batch when known. Staleness includes the intentional 175-tic (five-second) cap and should be assessed separately from HUD latency. Append RTT and append-plus-manifest time are separate. Percentiles
use nearest rank. Score rows/s counts unique observed State rows, not sink POSTs or SQL
writes. Cold results include input append and score delivery, not isolated replay CPU.

A 30-second idle projection explicitly releases the engine. The hosted cold test waits
longer, but cannot prove or force DO eviction through public APIs. Local workerd tests
force a process restart with persisted SQLite state. The CLI has no privileged restart
endpoint. Retained history length is the cold-rebuild input, not an assertion that a
particular Cloudflare object constructor ran.

Optional read-only analytics uses an already configured Alchemy profile or
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`. It creates/refreshes no token and writes
only namespace mappings and telemetry, never credentials:

```sh
bun scripts/loadtest/analytics.ts --profile default /path/to/scratch/families-10.json
```

Retry analytics after ingestion. Empty class results mean **not measured**. CPU and
wall time are microseconds; memory is sampled isolate usage, not per-engine memory.
Other traffic to the same class/window and adaptive sampling can affect telemetry.
The fast integration test is `bun test test/topology/loadtest.test.ts` (real Miniflare).

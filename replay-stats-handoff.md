# Batch 2 handoff — stopped at a published API gap

Intent: replace the v2 counter with verified server replay. Batch 2 is incomplete; do not accept this as the stats-projection implementation.
Delivered: `dg_stats` / named `stats()`, identical browser/worker WASM, nodejs_compat-safe worker glue, precompiled WASM bundling, shared-WAD/shared-baseline headless adapters, Bun/workerd engine tests.
Decisions: preserve batch 1's counter and topology; recover headless engines from a trusted pre-init baseline and inputs, never player heaps. No Streamsy files or packages changed; no deploy ran.
Deviations: the brief's stop rule was invoked for TTL-read feedback. Producer stats, cumulative checkpoint, idle binding, fork-stat proof and score-lag measurements remain unshipped.

Exact gap in published @streamsy/* 0.12.0 (source reference 974562fd5af53881f7e0585dcc62b74c23202cfe):
- `packages/projection/src/read.ts`, `readSlice`: projection inputs call the normal protocol `reader.read`.
- `packages/core/src/protocol/read.ts:55`, `readRecord`: every read calls `touch`.
- `packages/core/src/protocol/expiry.ts:41`, `touch`: a TTL stream read issues `Operations.Append` with no messages and a lifecycle patch.
- `packages/storage/src/storage.ts:750`, `SqlStorage.mutate`: every operation's id enters `boundary.mutation` and then `Storage.committed`.
- `packages/projection/src/attach.ts`, `runnerOf` (implemented in `runner.ts`): commits requeue source bindings; a read can wake its own binding again.
- `packages/core/src/protocol/options.ts:29`, `ReadOptions`: only `offset` exists; there is no supported no-touch projection read, including over ObjectLink.
Needed before continuing: prevent lifecycle-only TTL touches from waking unchanged projection inputs, or provide a supported side-effect-free projection read across local and linked inputs. The demo does not implement either workaround.

Measured reproduction: one JSON input, two attached process projections, one initial append, then no new frames. A requested 1000 ms idle wait executed 115,696 SQL queries and took 2561 ms; the following wait executed 191,268 queries and took 3578 ms. Only one input item was consumed. The engine-free reproduction and SQL trace are in scratch.
Scratch: `/home/gareth/Documents/Personal/scratch/2026-11-17-doom-cross-object-build/batch2`.
Artifacts: `repro-ttl-feedback.ts` / `.log`, `debug-query.log`, `projection-draft.patch`, `engine-measurements.json`, required check logs. The projection draft is unreviewed WIP, includes obsolete test expectations, and must not be applied as a finished change.

Checks: `bun install --frozen-lockfile`, `bun run fetch-wad`, `bun run typecheck`, `bun run test` (31 pass, 0 fail), `bun run build:cf` all passed for the delivered engine-only range. Workerd tests enable nodejs_compat; 22,000 browser/headless tics match, including killcount resets 3→0 and 2→0, deaths, baseline reset, malformed commands and RNG drift. Original topology tests remain unchanged and pass.
Measured local workerd round trips: engine creation including WAD assets/hash/init 54.5 ms; reset plus 21,000-tic replay 88.8 ms, repeat 69.3 ms; 200 warm five-tic requests p50 0.42 ms, p95 0.81 ms, max 1.05 ms. Drift 0; final stats equal Bun. These are request times, not CPU counters; reset replay excludes frame storage/alarms. Steady-state verified-score lag was not measured.
Inferred engine buffers: one 28,795,076-byte WAD + one 16,777,216-byte baseline + one 16,777,216-byte heap per engine (59.5 MiB for one engine), excluding runtime/temporary allocations. Isolate memory was not measurable through workerd's performance API.
Comparison: prior spike cold WAD/init/replay was 265.4 ms and warm five-tic p50/p95 0.9/1.5 ms; that combined cold request differs from this split measurement and is not an apples-to-apples CPU comparison.
Risks: engine build id changed as approved; old recordings remain served but cannot replay on this build. Actual isolate peak memory, stats publication, timers, trusted recovery through storage and hosted performance remain unproven. No generated assets are committed.

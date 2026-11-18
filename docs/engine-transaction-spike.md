# Engine transaction spike (Streamsy 0.12.0)

Measured locally on workerd through Miniflare, 2026-11-18. No deployment or hosted load.

The engine handler can await engine creation, native gzip and remote family-frame reads inside `Commit.transaction`. A test runs the real bound `doom-v2-replay` engine handler with its Commit replaced in the test only. It injects a SQLite checkpoint failure after the snapshot write and Game append. Snapshot, stats and checkpoint all roll back. Evicting the engine and retrying restores matching state, one snapshot and the exact replay row sequence.

Production retains `Commit.producer`. A second test leaves a real producer unit pinned by rejecting its final checkpoint write. Running that same binding with `Commit.transaction` fails before processing with:

```
Commit transaction cannot resume a pinned unit
```

The old checkpoint remains unchanged. Deploying the Commit switch while any replay has a pending unit would therefore stop that binding. This is an upgrade constraint, even though async transaction execution succeeds.

References in the installed 0.12.0 package:

- `node_modules/@streamsy/projection/dist/index.js`, `step`: rejects `before.record.pending` when `isPinned(projection.commit)` is false.
- The same file, `producer.apply`: pins the ranges/output sequences before delivering output, then settles the checkpoint.
- The same file, `transaction.apply`: runs the handler, output appends and checkpoint in `Transaction.withTransaction`.
- Runner documentation: `site/content/docs/reference/projection/runners.mdx`, “Binding concurrency”, in the read-only Streamsy checkout. SQLite/DO transaction bodies serialize; awaits are supported.

A migration policy for pending producer units is required before adoption. This batch does not reset checkpoints, rename the engine projection, drain bindings, or edit Streamsy packages. Under the brief's stop rule, that choice remains with the coordinator. Snapshot writes retain `INSERT OR IGNORE` for producer retries. Bun continues using its existing snapshot connection; adopting transactions there would also require moving snapshot writes onto the handler's SQL client (its `:memory:` databases currently use separate connections).

Reproduce:

```sh
DOOM_TEST_SCRATCH=<scratch-folder> bun test test/topology/cloudflare.test.ts --test-name-pattern 'transaction spike'
```

The experiment is confined to the test probe and tests; the production engine Commit is unchanged.

# streamsy-doom

Doom as a fold over an append-only input log, hosted on [Streamsy](https://streamsy.dev) Durable Streams. Play a game, watch the same input log live, seek using snapshots, then fork at any recorded tic and play a different future.

Inspired by Electric's [Doom on Durable Streams](https://electric.ax/blog/2026/04/20/doom-on-durable-streams). This demo rebuilds DoomGeneric from source and implements its own engine hooks, stream layer and client.

Read how the demo works at [streamsy.dev](https://streamsy.dev).

The code is GPL-2.0-or-later. See [LICENSE](LICENSE). The game data is Freedoom, under BSD-3-Clause.

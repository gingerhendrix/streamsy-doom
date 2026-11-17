# streamsy-doom

Doom as a fold over an append-only input log, hosted on [Streamsy](https://github.com/gingerhendrix/streamsy) Durable Streams.

A rebuild of Electric's "Durable Doom" demo. Every game tick appends one input frame to a stream. Observers tail the stream live, seek with heap snapshots, and fork a session at any tick.

Work in progress. See the plan in the Personal vault stream `2026-11-16/doom-on-streamsy`.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE). The engine is derived from DoomGeneric and id Software's Doom source, both under the GNU GPL version 2. No game data (WAD files) is committed to this repository.

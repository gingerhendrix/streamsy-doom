# Upstream and license record

Vendored repository: https://github.com/ozkl/doomgeneric

Pinned commit: `e257a09527062bfb986b6e5e0780839b6cbd5b71`.

`engine/doomgeneric/` contains the entire upstream tree, including its LICENSE,
READMEs, platform ports and screenshots, as exported by `git archive`. The
unmodified vendor commit is `982c198` (before our WASM hooks). The original brief
named `ozkriff/doomgeneric`, which returns 404; the user approved the corrected
URL and this pin on 2026-11-17.

## License check (2026-11-17)

The upstream LICENSE is the GNU GPL version 2 text. Of its 192 C/header files,
177 explicitly permit GNU GPL version 2 **or, at your option, any later version**.
This includes `g_game.c`, `d_main.c`, `d_ticcmd.h`, `m_random.c`, `i_video.c`,
`p_*.c` and the Chocolate Doom-derived engine files. These headers support this
repository's GPL-2.0-or-later license; no contrary version restriction was found.

The other 15 files have no separate license grant in their file headers:
`config.h`, `doom.h`, `doomgeneric.c`, `doomgeneric.h`, the eight
`doomgeneric_*.c` platform ports, `dummy.c`, `icon.c`, and `mus2mid.h`.
They are distributed within the upstream GPL-licensed repository. They do not
contain a GPL-2.0-only or incompatible notice. This records the actual header
coverage rather than claiming every DoomGeneric file has an explicit
or-later header. Existing copyright and license notices are retained unchanged.
Our added code carries `SPDX-License-Identifier: GPL-2.0-or-later`.

## Local changes

`STREAMSY_WASM` guards the fresh ticcmd hook, suppresses startup tics, and disables
clock-driven screen wipes. Other platform builds retain their original behavior.
The WASM platform and stateless WAD backend live outside the vendor directory,
in `engine/src/`. No code or build artifacts from durabledoom.com were used.

## Toolchain

Docker image: `emscripten/emsdk:4.0.23`, additionally pinned by manifest digest
`sha256:86537645c51e44899812d29820ee3b64b96c321ebb2aba4416a04ceeb1bcde62`.
Compilation happens entirely inside Docker; no host Emscripten is needed.

## Game data

Freedoom Phase 1 release **0.13.0** (BSD-3-Clause), downloaded by
`engine/scripts/fetch-wad.ts` from:
https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip

Archive SHA-256 (matches the release's `freedoom-0.13.0-CHECKSUM`):
`3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`.

Extracted `freedoom1.wad` SHA-256:
`7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d`.

Both hashes are checked before saving. `COPYING.txt` and `CREDITS.txt` are
extracted beside the WAD for future redistribution. No WAD or release archive
is committed. A user-supplied `DOOM_WAD` bypasses downloading; its identity is
still recorded in snapshots. The WAD is runtime input, not embedded build data.

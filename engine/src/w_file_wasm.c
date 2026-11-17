// SPDX-License-Identifier: GPL-2.0-or-later
/* Stateless positional IWAD reads. The immutable bytes live in JS, outside
 * snapshots; there are no FILE buffers, host descriptors or seek cursors to
 * restore. The JS adapter supplies identical bytes to every fresh instance. */
#include <string.h>
#include <emscripten.h>
#include "w_file.h"
#include "z_zone.h"

EM_JS(int, wad_length, (), { return Module['wadBytes'].length; });
EM_JS(int, wad_read, (unsigned int offset, void *dest, unsigned int size), {
    const data = Module['wadBytes'].subarray(offset, offset + size);
    HEAPU8.set(data, dest);
    return data.length;
});
extern wad_file_class_t stdc_wad_file;
static wad_file_t *open_wad(char *path)
{
    if (strcmp(path, "/doom1.wad") && strcmp(path, "doom1.wad")) return NULL;
    wad_file_t *wad = Z_Malloc(sizeof(*wad), PU_STATIC, NULL);
    wad->file_class = &stdc_wad_file;
    wad->mapped = NULL;
    wad->length = wad_length();
    return wad;
}
static void close_wad(wad_file_t *wad) { Z_Free(wad); }
static size_t read_wad(wad_file_t *wad, unsigned int offset, void *dest, size_t size)
{
    (void) wad;
    return wad_read(offset, dest, size);
}
wad_file_class_t stdc_wad_file = {open_wad, close_wad, read_wad};

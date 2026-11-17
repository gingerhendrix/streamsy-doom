// SPDX-License-Identifier: GPL-2.0-or-later
#include <stdint.h>
#include <string.h>
#include "doomgeneric.h"
#include "doomstat.h"
#include "d_loop.h"
#include "g_game.h"
#include "d_main.h"
#include "doomkeys.h"
#include "d_event.h"
#include "i_video.h"
#include "doom_wasm.h"

extern int prndindex;
extern void D_Display(void);
static uint8_t input[9], frame[9];
static int injecting, initialized, drift_count;
static char skill_arg[2], episode_arg[2], map_arg[3];
static char *args[] = {"doom", "-iwad", "/doom1.wad", "-skill", skill_arg,
    "-warp", episode_arg, map_arg, "-nosound", "-nomouse",
    "-config", "/config.cfg", "-extraconfig", "/extra.cfg"};

int dg_init(int skill, int episode, int map)
{
    if (initialized || skill < 1 || skill > 5 || episode < 1 || episode > 4
        || map < 1 || map > 9) return -1;
    skill_arg[0] = '0' + skill;
    episode_arg[0] = '0' + episode;
    map_arg[0] = '0' + map;
    singletics = true;
    doomgeneric_Create(sizeof(args) / sizeof(args[0]), args);
    screenvisible = false; /* Rendering is an explicit, independent call. */
    initialized = 1;
    return 0;
}

/* Hook immediately after G_Ticker chooses the actual command, before buttons
 * can be consumed/mutated. No struct layout or padding goes onto the wire. */
void dg_ticcmd(ticcmd_t *cmd)
{
    if (injecting)
    {
        memset(cmd, 0, sizeof(*cmd));
        cmd->forwardmove = (int8_t) input[0];
        cmd->sidemove = (int8_t) input[1];
        cmd->angleturn = (int16_t) (input[2] | input[3] << 8);
        cmd->consistancy = input[4];
        cmd->chatchar = input[6];
        cmd->buttons = input[7];
    }
    frame[0] = (uint8_t) cmd->forwardmove;
    frame[1] = (uint8_t) cmd->sidemove;
    frame[2] = (uint16_t) cmd->angleturn & 255;
    frame[3] = (uint16_t) cmd->angleturn >> 8;
    frame[4] = cmd->consistancy;
    frame[5] = 0; /* This upstream has a byte-sized consistancy member. */
    frame[6] = cmd->chatchar;
    frame[7] = cmd->buttons;
}

int dg_step(int replay)
{
    if (!initialized || (replay != 0 && replay != 1)) return -1;
    /* Reject noncanonical commands rather than silently discarding fields.
     * Local menu/pause/save operations are outside the input-log API. */
    if (replay && (input[5] || input[6] || (input[7] & 128))) return -1;
    injecting = replay;
    doomgeneric_Tick();
    frame[8] = prndindex;
    if (replay && frame[8] != input[8])
    {
        ++drift_count;
        return 1;
    }
    return 0;
}

/* Post game key events; the single-tic loop consumes them before G_BuildTiccmd.
 * Deliberately no DOM keyboard or menu events. Use Doom's key codes. */
int dg_key(int key, int down)
{
    event_t event = {0};
    if (!initialized || key < 0 || key > 255 || (down != 0 && down != 1)) return -1;
    switch (key) {
    case KEY_UPARROW: case KEY_DOWNARROW: case KEY_LEFTARROW: case KEY_RIGHTARROW:
    case KEY_RCTRL: case KEY_RALT: case KEY_RSHIFT: case ' ': case ',': case '.':
    case KEY_STRAFE_L: case KEY_STRAFE_R: case KEY_USE: case KEY_FIRE:
    case '1': case '2': case '3': case '4': case '5': case '6': case '7':
        break;
    default: return -1;
    }
    event.type = down ? ev_keydown : ev_keyup;
    event.data1 = key;
    D_PostEvent(&event);
    return 0;
}
uint8_t *dg_input(void) { return input; }
uint8_t *dg_frame(void) { return frame; }
int dg_gametic(void) { return gametic; }
int dg_prndindex(void) { return prndindex; }
int dg_drift_count(void) { return drift_count; }

static uint32_t hash_word(uint32_t h, uint32_t value)
{
    for (int i = 0; i < 4; ++i) { h = (h ^ (value & 255)) * 16777619u; value >>= 8; }
    return h;
}
uint32_t dg_state_hash(void)
{
    uint32_t h = 2166136261u;
    player_t *p = &players[consoleplayer];
    h = hash_word(h, gametic);
    h = hash_word(h, leveltime);
    h = hash_word(h, gamestate);
    h = hash_word(h, gameaction);
    h = hash_word(h, gameepisode);
    h = hash_word(h, gamemap);
    h = hash_word(h, prndindex);
    h = hash_word(h, p->playerstate);
    h = hash_word(h, p->health);
    h = hash_word(h, p->armorpoints);
    h = hash_word(h, p->readyweapon);
    h = hash_word(h, p->pendingweapon);
    for (int i = 0; i < NUMAMMO; ++i) h = hash_word(h, p->ammo[i]);
    if (p->mo)
    {
        h = hash_word(h, p->mo->x); h = hash_word(h, p->mo->y);
        h = hash_word(h, p->mo->z); h = hash_word(h, p->mo->angle);
        h = hash_word(h, p->mo->momx); h = hash_word(h, p->mo->momy);
        h = hash_word(h, p->mo->momz); h = hash_word(h, p->mo->health);
    }
    return h;
}
/* Stable signed 32-bit ABI; no compiler struct layout crosses into JS. */
static int32_t stats[16];
int32_t *dg_stats(void)
{
    player_t *p = &players[consoleplayer];
    stats[0] = gametic; stats[1] = gamestate; stats[2] = gameepisode; stats[3] = gamemap;
    stats[4] = leveltime; stats[5] = p->playerstate; stats[6] = p->health; stats[7] = p->armorpoints;
    stats[8] = p->killcount; stats[9] = p->itemcount; stats[10] = p->secretcount;
    stats[11] = totalkills; stats[12] = totalitems; stats[13] = totalsecret;
    stats[14] = p->readyweapon; stats[15] = p->ammo[0];
    return stats;
}
void dg_render(void) { if (initialized) D_Display(); }
pixel_t *dg_pixels(void) { return DG_ScreenBuffer; }

void DG_Init(void) {}
void DG_DrawFrame(void) {}
void DG_SetWindowTitle(const char *title) { (void) title; }
/* All timer reads are a function of the explicitly advanced simulation tic.
 * Wipes are disabled; no code waits for this clock to advance itself. */
uint32_t DG_GetTicksMs(void) { return (uint64_t) gametic * 1000 / 35; }
void DG_SleepMs(uint32_t ms) { (void) ms; }
int DG_GetKey(int *pressed, unsigned char *key) { return 0; }

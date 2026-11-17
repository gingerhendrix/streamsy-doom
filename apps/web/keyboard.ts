// SPDX-License-Identifier: GPL-2.0-or-later
import type { keys as engineKeys } from "../../engine/src/engine.js";

export class KeyboardControls {
  private readonly mapping: Record<string, number>;
  private readonly held = new Set<string>();
  constructor(keys: typeof engineKeys, private readonly sendKey: (code: number, down: boolean) => void) {
    this.mapping = {
      KeyW: keys.up, KeyS: keys.down, KeyA: keys.left, KeyD: keys.right,
      Space: keys.fire, Enter: keys.use, NumpadEnter: keys.use,
      ArrowUp: keys.up, ArrowDown: keys.down, ArrowLeft: keys.left, ArrowRight: keys.right,
      ControlLeft: keys.fire, ControlRight: keys.fire,
      AltLeft: keys.strafe, AltRight: keys.strafe, ShiftLeft: keys.run, ShiftRight: keys.run,
      Comma: keys.strafeLeft, Period: keys.strafeRight,
    };
    for (let n = 1; n <= 7; n++) this.mapping[`Digit${n}`] = 48 + n;
  }
  handle(event: Pick<KeyboardEvent, "code" | "key" | "type" | "preventDefault">, focused: boolean) {
    // Some browser automation and older keyboards omit physical code.
    const fallback: Record<string, string> = { Control: "ControlLeft", Alt: "AltLeft", Shift: "ShiftLeft", " ": "Space", ",": "Comma", ".": "Period" };
    const name = event.code || fallback[event.key] || (/^[wasd]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` : /^[1-7]$/.test(event.key) ? `Digit${event.key}` : event.key);
    const code = this.mapping[name];
    // Leave browser controls alone, but accept releases after focus moves away.
    if (code === undefined || (!focused && (event.type === "keydown" || !this.held.has(name)))) return;
    event.preventDefault();
    if (event.type === "keydown") this.held.add(name); else this.held.delete(name);
    this.sendKey(code, [...this.held].some(heldKey => this.mapping[heldKey] === code));
  }
  release() {
    this.held.clear();
    for (const code of new Set(Object.values(this.mapping))) this.sendKey(code, false);
  }
}

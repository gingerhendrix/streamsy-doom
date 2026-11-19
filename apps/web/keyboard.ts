// SPDX-License-Identifier: GPL-2.0-or-later
import type { keys as engineKeys } from "../../engine/src/engine.js";

type KeyEvent = Pick<KeyboardEvent, "code" | "key" | "type" | "preventDefault">;

const DIGIT_ZERO_KEY_CODE = 48;
const WEAPON_DIGITS = [1, 2, 3, 4, 5, 6, 7];

const physicalCodeOfKeyName: Record<string, string> = {
  Control: "ControlLeft",
  Alt: "AltLeft",
  Shift: "ShiftLeft",
  " ": "Space",
  ",": "Comma",
  ".": "Period",
};

function physicalCodeWhenEventHasNone(key: string) {
  if (physicalCodeOfKeyName[key]) return physicalCodeOfKeyName[key];
  if (/^[wasd]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[1-7]$/.test(key)) return `Digit${key}`;
  return key;
}

export class KeyboardControls {
  private readonly engineCodeOf: Record<string, number>;
  private readonly held = new Set<string>();

  constructor(
    keys: typeof engineKeys,
    private readonly sendKey: (code: number, down: boolean) => void,
  ) {
    this.engineCodeOf = {
      KeyW: keys.up,
      KeyS: keys.down,
      KeyA: keys.left,
      KeyD: keys.right,
      Space: keys.fire,
      Enter: keys.use,
      NumpadEnter: keys.use,
      ArrowUp: keys.up,
      ArrowDown: keys.down,
      ArrowLeft: keys.left,
      ArrowRight: keys.right,
      ControlLeft: keys.fire,
      ControlRight: keys.fire,
      AltLeft: keys.strafe,
      AltRight: keys.strafe,
      ShiftLeft: keys.run,
      ShiftRight: keys.run,
      Comma: keys.strafeLeft,
      Period: keys.strafeRight,
    };
    for (const digit of WEAPON_DIGITS)
      this.engineCodeOf[`Digit${digit}`] = DIGIT_ZERO_KEY_CODE + digit;
  }

  handle(event: KeyEvent, gameHasFocus: boolean) {
    const physicalCode = event.code || physicalCodeWhenEventHasNone(event.key);
    const engineCode = this.engineCodeOf[physicalCode];
    if (engineCode === undefined) return;
    const isPress = event.type === "keydown";
    const isReleaseOfKeyPressedWhileFocused = !isPress && this.held.has(physicalCode);
    if (!gameHasFocus && !isReleaseOfKeyPressedWhileFocused) return;
    event.preventDefault();
    if (isPress) this.held.add(physicalCode);
    else this.held.delete(physicalCode);
    this.sendKey(engineCode, this.anyHeldKeyMapsTo(engineCode));
  }

  private anyHeldKeyMapsTo(engineCode: number) {
    return [...this.held].some((heldCode) => this.engineCodeOf[heldCode] === engineCode);
  }

  release() {
    this.held.clear();
    for (const engineCode of new Set(Object.values(this.engineCodeOf)))
      this.sendKey(engineCode, false);
  }
}

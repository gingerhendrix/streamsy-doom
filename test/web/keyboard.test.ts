// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { keys } from "../../engine/src/engine.js";
import { KeyboardControls } from "../../apps/web/keyboard";

function setup() {
  const calls: [number, boolean][] = [];
  const keyboard = new KeyboardControls(keys, (code, down) => calls.push([code, down]));
  const send = (code: string, key = code, type = "keydown", focused = true) => {
    const event = { code, key, type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    keyboard.handle(event, focused);
    return event;
  };
  return { keyboard, calls, send };
}

test.each([
  ["KeyW", keys.up], ["KeyS", keys.down], ["KeyA", keys.left], ["KeyD", keys.right],
  ["Space", keys.fire], ["Enter", keys.use], ["NumpadEnter", keys.use],
] as const)("%s presses and releases its gameplay action", (name, code) => {
  const { send, calls } = setup();
  expect(send(name).defaultPrevented).toBe(true);
  expect(calls).toEqual([[code, true]]);
  expect(send(name, name, "keyup").defaultPrevented).toBe(true);
  expect(calls).toEqual([[code, true], [code, false]]);
});

test("existing arrows, modifiers, strafe keys and weapons still work", () => {
  const aliases = [
    ["ArrowUp", keys.up], ["ArrowDown", keys.down], ["ArrowLeft", keys.left], ["ArrowRight", keys.right],
    ["ControlLeft", keys.fire], ["ControlRight", keys.fire],
    ["AltLeft", keys.strafe], ["AltRight", keys.strafe], ["ShiftLeft", keys.run], ["ShiftRight", keys.run],
    ["Comma", keys.strafeLeft], ["Period", keys.strafeRight],
    ...Array.from({ length: 7 }, (_, n) => [`Digit${n + 1}`, 49 + n] as const),
  ] as const;
  for (const [name, code] of aliases) {
    const { send, calls } = setup();
    send(name); send(name, name, "keyup");
    expect(calls).toEqual([[code, true], [code, false]]);
  }
});

test("key-only events support WASD in either case, Space, Enter and old aliases", () => {
  const fallbacks = [
    ["w", keys.up], ["W", keys.up], ["s", keys.down], ["S", keys.down],
    ["a", keys.left], ["A", keys.left], ["d", keys.right], ["D", keys.right],
    [" ", keys.fire], ["Enter", keys.use], ["Control", keys.fire], ["Alt", keys.strafe],
    ["Shift", keys.run], [",", keys.strafeLeft], [".", keys.strafeRight], ["ArrowUp", keys.up], ["7", 55],
  ] as const;
  for (const [key, code] of fallbacks) {
    const { send, calls } = setup();
    send("", key); send("", key, "keyup");
    expect(calls).toEqual([[code, true], [code, false]]);
  }
  const { send, calls } = setup();
  send("KeyW", "z"); // Physical code takes precedence on other keyboard layouts.
  expect(calls).toEqual([[keys.up, true]]);
});

test("releasing one alias keeps the action held, including repeated keydowns", () => {
  for (const [first, second, code] of [["KeyW", "ArrowUp", keys.up], ["Space", "ControlLeft", keys.fire], ["Enter", "NumpadEnter", keys.use]] as const) {
    const { send, calls } = setup();
    send(first); send(first); send(second);
    send(first, first, "keyup");
    expect(calls.at(-1)).toEqual([code, true]);
    send(second, second, "keyup");
    expect(calls.at(-1)).toEqual([code, false]);
  }
});

test("unfocused Enter preserves browser menu, form and button confirmation", () => {
  const { send, calls } = setup();
  for (const name of ["Enter", "NumpadEnter", "Space", "KeyW", "ArrowUp"]) {
    expect(send(name, name, "keydown", false).defaultPrevented).toBe(false);
    expect(send(name, name, "keyup", false).defaultPrevented).toBe(false);
  }
  expect(calls).toEqual([]);
  expect(send("Escape").defaultPrevented).toBe(false);
  expect(calls).toEqual([]); // Engine menus remain outside the gameplay log.
});

test("a held action can be released after focus moves away", () => {
  const { send, calls } = setup();
  send("Enter");
  expect(send("Enter", "Enter", "keyup", false).defaultPrevented).toBe(true);
  expect(calls).toEqual([[keys.use, true], [keys.use, false]]);
});

test("blur and disposal release all actions and clear held aliases", () => {
  const { keyboard, send, calls } = setup();
  send("KeyW"); send("ArrowUp"); send("Space"); send("Enter");
  calls.length = 0;
  keyboard.release();
  expect(new Set(calls.map(([code]) => code))).toEqual(new Set([...Object.values(keys), 49, 50, 51, 52, 53, 54, 55]));
  expect(calls.every(([, down]) => !down)).toBe(true);
  expect(send("Enter", "Enter", "keyup", false).defaultPrevented).toBe(false);
  send("ArrowUp"); send("ArrowUp", "ArrowUp", "keyup");
  expect(calls.at(-1)).toEqual([keys.up, false]);
});

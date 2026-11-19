// SPDX-License-Identifier: GPL-2.0-or-later
export const find = <E extends Element = HTMLElement>(selector: string) =>
  document.querySelector<E>(selector)!;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

export const setText = (selector: string, text: string) => {
  find(selector).textContent = text;
};

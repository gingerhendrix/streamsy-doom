// SPDX-License-Identifier: GPL-2.0-or-later
export function serialQueue() {
  let previous: Promise<unknown> = Promise.resolve();
  return <A>(work: () => Promise<A>) => {
    const result = previous.then(work);
    previous = result.catch(() => {});
    return result;
  };
}

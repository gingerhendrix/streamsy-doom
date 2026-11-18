// SPDX-License-Identifier: GPL-2.0-or-later
export interface StateEvent<T> {
  type?: string;
  key?: string;
  value?: Partial<T>;
  headers: {
    operation?: "insert" | "upsert" | "update" | "delete";
    control?: "reset" | "snapshot-start" | "snapshot-end";
  };
}

/** One collection's Durable State fold. A partial update preserves other fields. */
export class StateRows<T extends object> {
  readonly rows = new Map<string, T>();
  private snapshot?: Set<string>;
  constructor(readonly collection: string) {}
  apply(events: readonly StateEvent<T>[]) {
    for (const event of events) {
      const { operation, control } = event.headers;
      if (control === "reset") {
        this.rows.clear();
        this.snapshot = undefined;
      } else if (control === "snapshot-start") this.snapshot = new Set();
      else if (control === "snapshot-end" && this.snapshot) {
        for (const key of this.rows.keys()) if (!this.snapshot.has(key)) this.rows.delete(key);
        this.snapshot = undefined;
      } else if (event.type === this.collection && event.key !== undefined) {
        if (operation === "delete") {
          this.rows.delete(event.key);
          this.snapshot?.delete(event.key);
        } else if (event.value && operation) {
          if (operation === "update") {
            const row = this.rows.get(event.key);
            if (row) this.rows.set(event.key, { ...row, ...event.value });
          } else this.rows.set(event.key, event.value as T);
          this.snapshot?.add(event.key);
        }
      }
    }
  }
}

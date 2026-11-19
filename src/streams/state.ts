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

export class StateRows<T extends object> {
  readonly rows = new Map<string, T>();
  private keysSeenInOpenSnapshot?: Set<string>;

  constructor(readonly collection: string) {}

  apply(events: readonly StateEvent<T>[]) {
    for (const event of events) {
      if (this.appliedAsControl(event.headers.control)) continue;
      if (event.type === this.collection && event.key !== undefined)
        this.applyChange(event.key, event);
    }
  }

  private appliedAsControl(control: StateEvent<T>["headers"]["control"]) {
    if (control === "reset") {
      this.rows.clear();
      this.keysSeenInOpenSnapshot = undefined;
      return true;
    }
    if (control === "snapshot-start") {
      this.keysSeenInOpenSnapshot = new Set();
      return true;
    }
    if (control === "snapshot-end" && this.keysSeenInOpenSnapshot) {
      this.deleteRowsMissingFrom(this.keysSeenInOpenSnapshot);
      this.keysSeenInOpenSnapshot = undefined;
      return true;
    }
    return false;
  }

  private deleteRowsMissingFrom(snapshotKeys: Set<string>) {
    for (const key of this.rows.keys()) if (!snapshotKeys.has(key)) this.rows.delete(key);
  }

  private applyChange(key: string, event: StateEvent<T>) {
    const { operation } = event.headers;
    if (operation === "delete") {
      this.rows.delete(key);
      this.keysSeenInOpenSnapshot?.delete(key);
      return;
    }
    if (!event.value || !operation) return;
    if (operation === "update") this.mergeIntoExistingRow(key, event.value);
    else this.rows.set(key, event.value as T);
    this.keysSeenInOpenSnapshot?.add(key);
  }

  private mergeIntoExistingRow(key: string, fields: Partial<T>) {
    const row = this.rows.get(key);
    if (row) this.rows.set(key, { ...row, ...fields });
  }
}

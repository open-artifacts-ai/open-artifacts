/** Last N delivered msg_ids. A repeat is acked, never injected again. */
export class Seen {
  #set = new Set<string>();
  #max: number;
  constructor(max = 1000) {
    this.#max = max;
  }
  /** True the first time; false if already present. */
  add(id: string): boolean {
    if (this.#set.has(id)) {
      this.#set.delete(id);
      this.#set.add(id);
      return false;
    }
    this.#set.add(id);
    if (this.#set.size > this.#max) {
      const first = this.#set.values().next().value;
      if (first !== undefined) this.#set.delete(first);
    }
    return true;
  }
  /** A hit refreshes recency. */
  has(id: string): boolean {
    if (!this.#set.has(id)) return false;
    this.#set.delete(id);
    this.#set.add(id);
    return true;
  }
  /** A failed delivery is not recorded, so the hub's retry is attempted again. */
  delete(id: string): void {
    this.#set.delete(id);
  }
}

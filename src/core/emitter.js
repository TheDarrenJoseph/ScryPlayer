/**
 * The smallest event emitter that does the job.
 *
 * A listener that throws must not take down the emitter — a broken UI
 * subscriber should never stop audio playback — so handlers are isolated.
 */
export class Emitter {
  #listeners = new Map();

  /** @returns {() => void} an unsubscribe function */
  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  emit(type, detail) {
    const set = this.#listeners.get(type);
    if (!set) return;
    // Copy so a handler may unsubscribe itself mid-dispatch.
    for (const fn of [...set]) {
      try {
        fn(detail);
      } catch (err) {
        console.error(`[scry] listener for "${type}" threw`, err);
      }
    }
  }
}

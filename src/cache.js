// Tiny TTL cache with in-flight de-duplication and stale-on-error fallback.
// If a refresh fails but we have an older value, we serve it marked stale
// instead of failing the request — agents prefer a slightly old number
// with a flag over an error.

export class TTLCache {
  constructor({ maxStaleMs = 6 * 60 * 60 * 1000 } = {}) {
    this.store = new Map(); // key -> { value, at }
    this.inflight = new Map(); // key -> Promise
    this.maxStaleMs = maxStaleMs;
  }

  /**
   * @returns {Promise<{value:any, at:number, stale:boolean, error?:string}>}
   */
  async get(key, ttlMs, loader) {
    const hit = this.store.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return { value: hit.value, at: hit.at, stale: false };

    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        const value = await loader();
        const entry = { value, at: Date.now() };
        this.store.set(key, entry);
        return { ...entry, stale: false };
      } catch (err) {
        if (hit && now - hit.at < this.maxStaleMs) {
          return { value: hit.value, at: hit.at, stale: true, error: err.message };
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  clear() {
    this.store.clear();
  }
}

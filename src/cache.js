// TTL cache with in-flight de-duplication, stale-on-error fallback, and
// failure backoff.
//
// - Fresh hit: returned as-is.
// - Refresh fails but an older value exists: the old value is served marked
//   stale, and the source is put on a cooldown (exponential, or the upstream's
//   Retry-After) so we don't hammer a rate-limited API on every request.
// - Every key records its health so /v1/status can say what's failing.

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 15 * 1000;

export class TTLCache {
  constructor({ maxStaleMs = 6 * 60 * 60 * 1000 } = {}) {
    this.store = new Map(); // key -> { value, at }
    this.inflight = new Map(); // key -> Promise
    this.meta = new Map(); // key -> { failures, nextRetryAt, lastError, lastErrorAt, lastOkAt }
    this.maxStaleMs = maxStaleMs;
  }

  /**
   * @returns {Promise<{value:any, at:number, stale:boolean, error?:string}>}
   */
  async get(key, ttlMs, loader) {
    const hit = this.store.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return { value: hit.value, at: hit.at, stale: false };

    const m = this.meta.get(key);
    const usable = hit && now - hit.at < this.maxStaleMs;
    if (m && m.nextRetryAt > now) {
      // Cooling down after a failure: don't call upstream yet.
      if (usable) return { value: hit.value, at: hit.at, stale: true, error: m.lastError };
      const e = new Error(m.lastError || 'source cooling down after errors');
      e.cooldown = true;
      throw e;
    }

    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        const value = await loader();
        const entry = { value, at: Date.now() };
        this.store.set(key, entry);
        this.meta.set(key, { ...(this.meta.get(key) || {}), failures: 0, nextRetryAt: 0, lastOkAt: entry.at });
        return { ...entry, stale: false };
      } catch (err) {
        const prev = this.meta.get(key) || {};
        const failures = (prev.failures || 0) + 1;
        const backoff = err.retryAfterMs > 0
          ? Math.min(MAX_BACKOFF_MS, err.retryAfterMs)
          : Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
        this.meta.set(key, { ...prev, failures, nextRetryAt: Date.now() + backoff, lastError: err.message, lastErrorAt: Date.now() });
        if (usable) return { value: hit.value, at: hit.at, stale: true, error: err.message };
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Health snapshot for every key that has been used. */
  health() {
    const now = Date.now();
    const out = {};
    const keys = new Set([...this.store.keys(), ...this.meta.keys()]);
    for (const key of keys) {
      const hit = this.store.get(key);
      const m = this.meta.get(key) || {};
      out[key] = {
        ok: !m.failures,
        data_age_sec: hit ? Math.round((now - hit.at) / 1000) : null,
        last_success: m.lastOkAt ? new Date(m.lastOkAt).toISOString() : null,
        consecutive_failures: m.failures || 0,
        ...(m.lastError ? { last_error: m.lastError, last_error_at: new Date(m.lastErrorAt).toISOString() } : {}),
        ...(m.nextRetryAt > now ? { retry_in_sec: Math.ceil((m.nextRetryAt - now) / 1000) } : {}),
      };
    }
    return out;
  }

  clear() {
    this.store.clear();
    this.meta.clear();
  }
}

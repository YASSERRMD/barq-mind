// Tiny performance profiler. Records spans by name, exposes percentile and
// total stats, and emits live waterfall events the UI can subscribe to.

export class Profiler {
  constructor() {
    this.spans = [];
    this.listeners = [];
  }

  start(name, meta = {}) {
    const token = { name, meta, startedAt: performance.now() };
    return token;
  }

  end(token, extraMeta = {}) {
    const endedAt = performance.now();
    const span = {
      name: token.name,
      startedAt: token.startedAt,
      endedAt,
      durationMs: endedAt - token.startedAt,
      meta: { ...token.meta, ...extraMeta },
    };
    this.spans.push(span);
    for (const fn of this.listeners) {
      try { fn(span); } catch { /* ignore listener errors */ }
    }
    return span;
  }

  async measure(name, fn, meta) {
    const token = this.start(name, meta);
    try {
      const result = await fn();
      this.end(token);
      return result;
    } catch (e) {
      this.end(token, { error: e.message });
      throw e;
    }
  }

  on(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  reset() {
    this.spans = [];
  }

  report() {
    const byName = new Map();
    for (const s of this.spans) {
      const arr = byName.get(s.name) || [];
      arr.push(s.durationMs);
      byName.set(s.name, arr);
    }
    const out = {};
    for (const [name, durations] of byName) {
      const sorted = [...durations].sort((a, b) => a - b);
      const total = durations.reduce((a, b) => a + b, 0);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      out[name] = {
        count: durations.length,
        totalMs: total,
        p50,
        p95,
        avgMs: total / durations.length,
      };
    }
    return out;
  }

  recent(limit = 50) {
    return this.spans.slice(-limit);
  }
}

export const profiler = new Profiler();

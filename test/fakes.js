export function createMemoryStorage() {
  const values = new Map();

  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

export function createFakeClock(initial = Date.parse("2026-08-03T12:00:00.000Z")) {
  let current = initial;

  return {
    now() {
      return current;
    },
    advance(milliseconds) {
      current += milliseconds;
      return current;
    },
  };
}

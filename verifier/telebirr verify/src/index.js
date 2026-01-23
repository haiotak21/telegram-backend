function createReceiptVerifier(parsed = {}, expected = {}) {
  function toComparable(x) {
    if (x === undefined || x === null) return null;
    if (typeof x === 'number') return x;
    const s = String(x).trim();
    const n = Number(s);
    return Number.isFinite(n) && /^(?:\d+(?:\.\d+)?)$/.test(s) ? n : s;
  }

  function equals(a, b) {
    const A = toComparable(a);
    const B = toComparable(b);
    if (A === null || B === null) return false;
    return A === B;
  }

  function verify(callback) {
    try {
      return !!callback(parsed, expected);
    } catch {
      return false;
    }
  }

  function verifyAll(options = {}) {
    const ignore = options.ignore || [];
    const keys = Object.keys(parsed);
    if (keys.length === 0) return false;
    for (const k of keys) {
      if (ignore.includes(k)) continue;
      if (!equals(parsed[k], expected[k])) return false;
    }
    return true;
  }

  function verifyOnly(fields = []) {
    if (!Array.isArray(fields) || fields.length === 0) return false;
    for (const k of fields) {
      if (!equals(parsed[k], expected[k])) return false;
    }
    return true;
  }

  return { equals, verify, verifyAll, verifyOnly, parsed, expected };
}

module.exports = { createReceiptVerifier };

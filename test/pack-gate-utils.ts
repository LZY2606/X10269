/**
 * Shared helpers for the publish-tarball gate tests.
 *
 * These helpers never special-case the library under test; they only provide
 * deterministic data generation and first-violation reporting so that a
 * failing assertion points at the exact evidence instead of a bare boolean.
 */

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function describeValue(value: unknown): string {
  if (value instanceof Date) return `Date(${value.getTime()})`;
  if (isView(value)) {
    return `${value.constructor.name}([${Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    ).join(',')}])`;
  }
  if (typeof value === 'bigint') return `${value}n`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Structural comparison that returns a human-readable description of the
 * FIRST contract violation (path + both values), or null when equal.
 * Key order of plain objects is significant: plist preserves insertion order.
 */
export function firstDifference(
  actual: unknown,
  expected: unknown,
  path = '$',
): string | null {
  if (actual === expected) return null;

  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isNaN(actual) && Number.isNaN(expected)) return null;
    return `${path}: number mismatch, actual=${actual}, expected=${expected}`;
  }

  if (actual instanceof Date || expected instanceof Date) {
    if (actual instanceof Date && expected instanceof Date) {
      if (actual.getTime() === expected.getTime()) return null;
      return `${path}: Date mismatch, actual=${actual.getTime()} (${actual.toISOString()}), expected=${expected.getTime()} (${expected.toISOString()})`;
    }
    return `${path}: type mismatch, actual=${describeValue(actual)}, expected=${describeValue(expected)}`;
  }

  if (isView(actual) || isView(expected)) {
    if (isView(actual) && isView(expected)) {
      const a = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
      const b = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength);
      if (a.byteLength !== b.byteLength) {
        return `${path}: data length mismatch, actual=${a.byteLength} bytes, expected=${b.byteLength} bytes`;
      }
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          return `${path}: data byte ${i} mismatch, actual=0x${a[i].toString(16)}, expected=0x${b[i].toString(16)}`;
        }
      }
      return null;
    }
    return `${path}: type mismatch, actual=${describeValue(actual)}, expected=${describeValue(expected)}`;
  }

  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (Array.isArray(actual) && Array.isArray(expected)) {
      if (actual.length !== expected.length) {
        return `${path}: array length mismatch, actual=${actual.length}, expected=${expected.length}`;
      }
      for (let i = 0; i < actual.length; i++) {
        const diff = firstDifference(actual[i], expected[i], `${path}[${i}]`);
        if (diff) return diff;
      }
      return null;
    }
    return `${path}: type mismatch, actual=${describeValue(actual)}, expected=${describeValue(expected)}`;
  }

  if (
    actual !== null &&
    expected !== null &&
    typeof actual === 'object' &&
    typeof expected === 'object'
  ) {
    const aKeys = Object.keys(actual as object);
    const bKeys = Object.keys(expected as object);
    if (aKeys.length !== bKeys.length) {
      return `${path}: key count mismatch, actual keys=[${aKeys.join(',')}], expected keys=[${bKeys.join(',')}]`;
    }
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) {
        return `${path}: key order mismatch at position ${i}, actual key=${JSON.stringify(aKeys[i])}, expected key=${JSON.stringify(bKeys[i])} (actual order=[${aKeys.join(',')}], expected order=[${bKeys.join(',')}])`;
      }
    }
    for (const key of aKeys) {
      const diff = firstDifference(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (diff) return diff;
    }
    return null;
  }

  if (actual !== expected) {
    return `${path}: value mismatch, actual=${describeValue(actual)}, expected=${describeValue(expected)}`;
  }
  return null;
}

/** Deterministic serialization used to compare results across runs/orders. */
export function stableSerialize(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return { $type: 'bigint', value: val.toString() };
    if (val instanceof Date) return { $type: 'date', value: val.getTime() };
    if (isView(val)) {
      return {
        $type: 'data',
        value: Array.from(
          new Uint8Array(val.buffer, val.byteOffset, val.byteLength),
        ),
      };
    }
    if (val !== null && typeof val === 'object') {
      if (seen.has(val)) throw new Error('cyclic value cannot be serialized');
      seen.add(val);
    }
    return val;
  });
}

export interface GenBudget {
  maxDepth: number;
  maxBreadth: number;
  maxStringLength: number;
  maxDataLength: number;
}

export const DEFAULT_BUDGET: GenBudget = {
  maxDepth: 5,
  maxBreadth: 5,
  maxStringLength: 12,
  maxDataLength: 16,
};

const STRING_ALPHABET = [
  'a', 'B', 'z', '0', '9', ' ', '&', '<', '>', '"', "'",
  'é', '中', '文', '🚀', '\n', '.', '-', '_',
];

const KEY_ALPHABET = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
];

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function genString(rng: () => number, budget: GenBudget): string {
  const len = Math.floor(rng() * (budget.maxStringLength + 1));
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, STRING_ALPHABET);
  return out;
}

/**
 * Generate a random plist-compatible value within the given budget.
 * Only shapes inside the library's documented support scope are produced:
 * no null/undefined leaves, second-precision dates (XML scope), safe-range
 * integers, and no single-key `UID` dicts (reserved for the UID fixture).
 */
export function generatePlistValue(
  rng: () => number,
  budget: GenBudget = DEFAULT_BUDGET,
  depth = 0,
): unknown {
  const scalarKinds = ['string', 'int', 'real', 'bool', 'date', 'data', 'bigint'] as const;
  const kinds: readonly string[] =
    depth >= budget.maxDepth ? scalarKinds : [...scalarKinds, 'array', 'dict'];
  const kind = pick(rng, kinds);

  switch (kind) {
    case 'string':
      return genString(rng, budget);
    case 'int': {
      const n = Math.floor((rng() * 2 - 1) * Number.MAX_SAFE_INTEGER);
      return Object.is(n, -0) ? 0 : n;
    }
    case 'real': {
      const n = (rng() * 2 - 1) * 1e6 + rng();
      return Object.is(n, -0) ? 0 : n;
    }
    case 'bool':
      return rng() < 0.5;
    case 'date':
      // second precision: supported by both the XML and binary encodings
      return new Date(Math.floor((rng() * 2e12) / 1000) * 1000);
    case 'data': {
      const len = Math.floor(rng() * (budget.maxDataLength + 1));
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = Math.floor(rng() * 256);
      return bytes;
    }
    case 'bigint': {
      const n = Math.floor((rng() * 2 - 1) * Number.MAX_SAFE_INTEGER);
      return BigInt(n);
    }
    case 'array': {
      const len = Math.floor(rng() * (budget.maxBreadth + 1));
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) arr.push(generatePlistValue(rng, budget, depth + 1));
      return arr;
    }
    case 'dict': {
      const size = Math.floor(rng() * (budget.maxBreadth + 1));
      const obj: Record<string, unknown> = {};
      const usedKeys = new Set<string>();
      for (let i = 0; i < size; i++) {
        let key = `${pick(rng, KEY_ALPHABET)}_${Math.floor(rng() * 1000)}`;
        while (usedKeys.has(key) || key === 'UID') {
          key = `${pick(rng, KEY_ALPHABET)}_${Math.floor(rng() * 100000)}`;
        }
        usedKeys.add(key);
        obj[key] = generatePlistValue(rng, budget, depth + 1);
      }
      return obj;
    }
    default:
      throw new Error(`unknown kind: ${kind}`);
  }
}

/**
 * Normalize a generated value into the shape a round-trip is expected to
 * return, given the library's supported scope:
 * - bigint parses back as a Number (both encodings),
 * - Buffer/typed-array data parses back as Uint8Array,
 * - the XML encoding stores dates with second precision.
 */
export function normalizeForRoundTrip(
  value: unknown,
  encoding: 'xml' | 'binary',
): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) {
    if (encoding === 'xml') {
      return new Date(Math.floor(value.getTime() / 1000) * 1000);
    }
    return new Date(value.getTime());
  }
  if (isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForRoundTrip(item, encoding));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object)) {
      out[key] = normalizeForRoundTrip(
        (value as Record<string, unknown>)[key],
        encoding,
      );
    }
    return out;
  }
  return value;
}

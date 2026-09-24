import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared contract material for the plist publish-gate / roundtrip tests.
 *
 * Everything here is test-only support code. The behaviour under test is
 * always exercised through the library's public entries (`parse`, `build`,
 * `parseBinary`, `buildBinary`), never through internal shortcuts.
 */

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixturesDir = join(repoRoot, 'test', 'fixtures');

/** Minimal shape of any public plist entry point (node, browser, packed). */
export interface PlistEntry {
  parse: (input: string | Uint8Array | ArrayBuffer) => unknown;
  build: (value: unknown) => string;
  parseBinary: (data: Uint8Array) => unknown;
  buildBinary: (value: unknown) => Uint8Array;
}

export interface ValueCase {
  /** Contract name; appears in failure output. */
  name: string;
  value: unknown;
  /** Set false to skip the XML path (e.g. UID is binary-only). */
  xml?: boolean;
  /** Set false to skip the binary path. */
  binary?: boolean;
}

/**
 * Fixed fixtures. Dates use whole seconds because the XML builder emits
 * second precision; bigints stay inside the safe-integer range because the
 * parsers materialise integers as Number. Both are the library's documented
 * support scope.
 */
export const valueCases: ValueCase[] = [
  {
    name: 'xml-entity-text',
    value: {
      text: 'Fish & Chips <tag> "dq" \'sq\' € 😀',
      literalEntity: '&amp; &lt; &gt;',
      cdataLike: '<![CDATA[not really]]>',
    },
  },
  {
    name: 'buffer-and-data',
    value: {
      payload: new Uint8Array([0, 1, 2, 127, 128, 253, 254, 255]),
      empty: new Uint8Array(0),
    },
  },
  {
    name: 'whole-second-dates',
    value: {
      created: new Date('2024-01-02T03:04:05Z'),
      epoch2001: new Date('2001-01-01T00:00:00Z'),
      farFuture: new Date('2099-12-31T23:59:59Z'),
    },
  },
  {
    name: 'nested-arrays',
    value: [
      [['a'], [1, 2]],
      [],
      [[true, false], [2.5, -7]],
      [['deep', ['deeper', ['deepest']]]],
    ],
  },
  {
    name: 'uid-binary-only',
    value: { UID: 4242 },
    xml: false,
  },
  {
    name: 'safe-bigint',
    value: { max: BigInt('9007199254740991'), negative: BigInt('-42') },
  },
  {
    name: 'key-order',
    value: { z: 1, a: 2, m: 3, nested: { y: 'y', b: 'b' } },
  },
  {
    name: 'scalars',
    value: {
      int: 42,
      neg: -7,
      real: 3.5,
      truthy: true,
      falsy: false,
      str: 'hello',
      emptyStr: '',
      emptyDict: {},
      emptyArr: [],
    },
  },
];

export interface CorruptCase {
  name: string;
  mode: 'xml' | 'binary';
  input: string | Uint8Array;
  errorName: string;
  message: string;
}

/** Fixed corrupted inputs; every rejection must be repeatable. */
export const corruptCases: CorruptCase[] = [
  {
    name: 'corrupt-not-xml-file',
    mode: 'xml',
    input: readFileSync(join(fixturesDir, 'corrupt-not-xml.plist'), 'utf8'),
    errorName: 'ParseError',
    message: 'missing root element',
  },
  {
    name: 'corrupt-double-key',
    mode: 'xml',
    input:
      '<plist version="1.0"><dict><key>a</key><key>b</key></dict></plist>',
    errorName: 'Error',
    message:
      'Unexpected <key> while parsing <dict/>. Keys and values must alternate.',
  },
  {
    name: 'corrupt-empty-integer',
    mode: 'xml',
    input: '<plist version="1.0"><integer/></plist>',
    errorName: 'Error',
    message: 'Cannot parse "" as integer.',
  },
  {
    name: 'corrupt-bad-magic',
    mode: 'binary',
    input: new Uint8Array([1, 2, 3]),
    errorName: 'Error',
    message: 'Invalid binary plist: bad magic',
  },
  {
    name: 'corrupt-truncated-bplist-file',
    mode: 'binary',
    input: new Uint8Array(readFileSync(join(fixturesDir, 'corrupt-truncated.bplist'))),
    errorName: 'RangeError',
    message: 'Offset is outside the bounds of the DataView',
  },
];

/**
 * Normalise a PlistValue into a comparable structure, limited to the
 * library's supported semantics: Dates by epoch ms, Data by bytes, bigint by
 * its safe-integer Number value, object keys in insertion order.
 */
export function normalizePlist(value: unknown): unknown {
  if (value instanceof Date) return { $type: 'date', ms: value.getTime() };
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new Error(`bigint ${value} is outside the supported safe-integer range`);
    }
    // Both parsers materialise integers as Number, so a safe-range bigint
    // roundtrips into its numeric value.
    return asNumber;
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $type: 'data',
      hex: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex'),
    };
  }
  if (value instanceof ArrayBuffer) {
    return { $type: 'data', hex: Buffer.from(value).toString('hex') };
  }
  if (Array.isArray(value)) return value.map(normalizePlist);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = normalizePlist((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface Difference {
  path: string;
  expected: unknown;
  actual: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Find the first semantic difference between two normalised values,
 * including object key order. Returns null when they are equal.
 */
export function firstDifference(expected: unknown, actual: unknown, path = '$'): Difference | null {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = firstDifference(expected[i], actual[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    if (expectedKeys.length !== actualKeys.length) {
      return { path: `${path}.keys`, expected: expectedKeys, actual: actualKeys };
    }
    for (let i = 0; i < expectedKeys.length; i++) {
      if (expectedKeys[i] !== actualKeys[i]) {
        return { path: `${path}.keys[${i}]`, expected: expectedKeys[i], actual: actualKeys[i] };
      }
    }
    for (const key of expectedKeys) {
      const diff = firstDifference(expected[key], actual[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  return { path, expected, actual };
}

export function formatDifference(diff: Difference): string {
  return `first violation at ${diff.path} :: expected ${JSON.stringify(diff.expected)} but got ${JSON.stringify(diff.actual)}`;
}

/**
 * Assert that a corrupted input is rejected through the library's existing
 * error layering: an Error instance with a stable constructor and message,
 * identical on every attempt. Returns the observed rejection for recording.
 */
export function expectRepeatableRejection(
  entry: Pick<PlistEntry, 'parse' | 'parseBinary'>,
  corrupt: CorruptCase,
  context = '',
): { name: string; errorName: string; message: string } {
  const observed: { errorName: string; message: string }[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (corrupt.mode === 'xml') entry.parse(corrupt.input);
      else entry.parseBinary(corrupt.input as Uint8Array);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error(
          `[corrupt-input] non-Error rejection :: ${JSON.stringify({ case: corrupt.name, attempt, thrown: String(error), context })}`,
        );
      }
      observed.push({ errorName: error.constructor.name, message: error.message });
      continue;
    }
    throw new Error(
      `[corrupt-input] expected rejection but the call succeeded :: ${JSON.stringify({ case: corrupt.name, attempt, context })}`,
    );
  }
  const [first, second] = observed;
  if (first.errorName !== second.errorName || first.message !== second.message) {
    throw new Error(
      `[corrupt-input] rejection is not repeatable :: ${JSON.stringify({ case: corrupt.name, first, second, context })}`,
    );
  }
  if (first.errorName !== corrupt.errorName || first.message !== corrupt.message) {
    throw new Error(
      `[corrupt-input] rejection escaped the existing error layering :: ${JSON.stringify({
        case: corrupt.name,
        expected: { errorName: corrupt.errorName, message: corrupt.message },
        actual: first,
        context,
      })}`,
    );
  }
  return { name: corrupt.name, ...first };
}

/** Deterministic PRNG so property tests reproduce exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Property-test budget: fixed seed, fixed case count, bounded shapes. */
export const PROPERTY_SEED = 0x5eed;
export const PROPERTY_CASES = 64;
const PROPERTY_MAX_DEPTH = 4;
const PROPERTY_MAX_FANOUT = 4;

const STRING_ALPHABET = [
  'alpha',
  '&amp;',
  'a & b <c>',
  '"quoted"',
  "'apos'",
  '€😀',
  '',
  '42',
  'line\nbreak',
];
const KEY_POOL = ['name', 'value', 'items', 'meta', 'count', 'flag', 'data', 'when', 'uid', 'extra'];

function generateLeaf(rand: () => number): unknown {
  const kind = Math.floor(rand() * 7);
  switch (kind) {
    case 0:
      return STRING_ALPHABET[Math.floor(rand() * STRING_ALPHABET.length)];
    case 1:
      return Math.floor(rand() * 2 ** 32) - 2 ** 31;
    case 2:
      return rand() * 2000 - 1000;
    case 3:
      return rand() < 0.5;
    case 4:
      // whole-second dates inside the binary plist float64 exact range
      return new Date(978307200000 + Math.floor(rand() * 3124224000) * 1000);
    case 5: {
      const bytes = new Uint8Array(Math.floor(rand() * 17));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
      return bytes;
    }
    default:
      return BigInt(Math.floor(rand() * (2 ** 53 - 1)) - 2 ** 52);
  }
}

/** Generate a bounded, deterministic PlistValue for the given PRNG. */
export function generatePlistValue(rand: () => number, depth = PROPERTY_MAX_DEPTH): unknown {
  if (depth <= 0) return generateLeaf(rand);
  const kind = Math.floor(rand() * 5);
  if (kind < 2) return generateLeaf(rand);
  if (kind === 2) {
    const length = Math.floor(rand() * (PROPERTY_MAX_FANOUT + 1));
    const arr: unknown[] = [];
    for (let i = 0; i < length; i++) arr.push(generatePlistValue(rand, depth - 1));
    return arr;
  }
  if (kind === 3) {
    const count = Math.floor(rand() * (PROPERTY_MAX_FANOUT + 1));
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      let key = KEY_POOL[Math.floor(rand() * KEY_POOL.length)];
      while (key in obj) key = `${key}${i}`;
      obj[key] = generatePlistValue(rand, depth - 1);
    }
    return obj;
  }
  return { UID: Math.floor(rand() * 2 ** 24) };
}

/** Seeded Fisher-Yates shuffle; returns a new array. */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

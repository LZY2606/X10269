import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';
import {
  PROPERTY_CASES,
  PROPERTY_SEED,
  corruptCases,
  expectRepeatableRejection,
  firstDifference,
  fixturesDir,
  formatDifference,
  generatePlistValue,
  mulberry32,
  normalizePlist,
  shuffled,
  valueCases,
  type PlistEntry,
} from './support/plist-contracts.js';

const plist: PlistEntry = entry;

function roundtripResults(cases: typeof valueCases): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const c of cases) {
    if (c.xml !== false) {
      results[`${c.name}::xml`] = normalizePlist(plist.parse(plist.build(c.value)));
    }
    if (c.binary !== false) {
      results[`${c.name}::binary`] = normalizePlist(plist.parseBinary(plist.buildBinary(c.value)));
    }
  }
  return results;
}

describe('plist roundtrip contracts (fixed fixtures)', () => {
  it('parses the XML entity fixture through the public parse entry', () => {
    const parsed = plist.parse(readFileSync(join(fixturesDir, 'entities.plist'), 'utf8'));
    expect(parsed).toEqual({
      'fish&chips': '5 < 6 & 7 > 2 "quoted" \'apos\' € 😀',
      'literal-entity-text': '&amp; &lt; &gt;',
      'tag-like': '<tag attr="a&b">',
    });
  });

  it('roundtrips entity-heavy strings through build without double-encoding', () => {
    const value = { s: 'a & b <tag> "dq" \'sq\' &amp; € 😀' };
    const diff = firstDifference(normalizePlist(value), normalizePlist(plist.parse(plist.build(value))));
    expect(diff, diff ? formatDifference(diff) : undefined).toBeNull();
  });

  it('roundtrips the binary object graph fixtures (types/nested/Info bplist)', () => {
    for (const fixture of ['types.bplist', 'nested.bplist', 'Info.bplist']) {
      const parsed = plist.parseBinary(new Uint8Array(readFileSync(join(fixturesDir, fixture))));
      const expected = normalizePlist(parsed);
      const binDiff = firstDifference(expected, normalizePlist(plist.parseBinary(plist.buildBinary(parsed))));
      expect(binDiff, binDiff ? `${fixture} binary: ${formatDifference(binDiff)}` : undefined).toBeNull();
      const xmlDiff = firstDifference(expected, normalizePlist(plist.parse(plist.build(parsed))));
      expect(xmlDiff, xmlDiff ? `${fixture} xml: ${formatDifference(xmlDiff)}` : undefined).toBeNull();
    }
  });

  it('roundtrips Buffer/Data, date, nested arrays and scalars via XML and binary', () => {
    for (const c of valueCases) {
      const expected = normalizePlist(c.value);
      if (c.xml !== false) {
        const diff = firstDifference(expected, normalizePlist(plist.parse(plist.build(c.value))));
        expect(diff, diff ? `${c.name} xml: ${formatDifference(diff)}` : undefined).toBeNull();
      }
      if (c.binary !== false) {
        const diff = firstDifference(expected, normalizePlist(plist.parseBinary(plist.buildBinary(c.value))));
        expect(diff, diff ? `${c.name} binary: ${formatDifference(diff)}` : undefined).toBeNull();
      }
    }
  });

  it('accepts Buffer and Uint8Array views and preserves their bytes', () => {
    const bytes = [0, 1, 2, 127, 128, 253, 254, 255];
    const fromBuffer = plist.parse(plist.build({ d: Buffer.from(bytes) })) as { d: Uint8Array };
    const fromView = plist.parse(plist.build({ d: new Uint8Array(bytes) })) as { d: Uint8Array };
    expect(Buffer.from(fromBuffer.d).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
    expect(Buffer.from(fromView.d).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
  });

  it('preserves key insertion order through XML and binary roundtrips', () => {
    const value = { z: 1, a: 2, m: 3, nested: { y: 'y', b: 'b' } };
    const viaXml = plist.parse(plist.build(value)) as Record<string, unknown>;
    expect(Object.keys(viaXml)).toEqual(['z', 'a', 'm', 'nested']);
    expect(Object.keys(viaXml.nested as Record<string, unknown>)).toEqual(['y', 'b']);
    const viaBinary = plist.parseBinary(plist.buildBinary(value)) as Record<string, unknown>;
    expect(Object.keys(viaBinary)).toEqual(['z', 'a', 'm', 'nested']);
    expect(Object.keys(viaBinary.nested as Record<string, unknown>)).toEqual(['y', 'b']);
  });

  it('rejects corrupted inputs with repeatable errors from the existing layering', () => {
    const observed = corruptCases.map((c) => expectRepeatableRejection(plist, c, 'fixed-fixtures'));
    expect(observed).toEqual(
      corruptCases.map((c) => ({ name: c.name, errorName: c.errorName, message: c.message })),
    );
    // The rejections must not poison the library: a valid roundtrip still works.
    const probe = { after: 'failures', n: 1 };
    const diff = firstDifference(normalizePlist(probe), normalizePlist(plist.parse(plist.build(probe))));
    expect(diff, diff ? formatDifference(diff) : undefined).toBeNull();
  });

  it('builds byte-identical output on repeated calls (idempotent)', () => {
    for (const c of valueCases) {
      if (c.xml !== false) {
        expect(plist.build(c.value), `${c.name}: XML build is not idempotent`).toBe(plist.build(c.value));
      }
      if (c.binary !== false) {
        const first = Buffer.from(plist.buildBinary(c.value)).toString('hex');
        const second = Buffer.from(plist.buildBinary(c.value)).toString('hex');
        expect(first, `${c.name}: binary build is not idempotent`).toBe(second);
      }
    }
  });
});

describe('plist roundtrip contracts (order and schedule stability)', () => {
  const baseline = roundtripResults(valueCases);

  it('produces identical per-case results under shuffled execution orders', () => {
    const rand = mulberry32(0x5eed0);
    for (let round = 0; round < 8; round++) {
      const results = roundtripResults(shuffled(valueCases, rand));
      for (const key of Object.keys(baseline)) {
        const diff = firstDifference(baseline[key], results[key], key);
        expect(diff, diff ? `round ${round}: ${formatDifference(diff)}` : undefined).toBeNull();
      }
    }
  });

  it('produces identical results under concurrent scheduling', async () => {
    const concurrent: Record<string, unknown> = {};
    await Promise.all(
      shuffled(valueCases, mulberry32(0xc0c)).map(async (c) => {
        Object.assign(concurrent, roundtripResults([c]));
      }),
    );
    for (const key of Object.keys(baseline)) {
      const diff = firstDifference(baseline[key], concurrent[key], key);
      expect(diff, diff ? formatDifference(diff) : undefined).toBeNull();
    }
  });

  it('interleaved failing calls do not alter later results', () => {
    const polluted: Record<string, unknown> = {};
    valueCases.forEach((c, i) => {
      Object.assign(polluted, roundtripResults([c]));
      // Inject a recoverable failure between successful calls.
      const corrupt = corruptCases[i % corruptCases.length];
      expect(() =>
        corrupt.mode === 'xml' ? plist.parse(corrupt.input) : plist.parseBinary(corrupt.input as Uint8Array),
      ).toThrow(corrupt.message);
    });
    for (const key of Object.keys(baseline)) {
      const diff = firstDifference(baseline[key], polluted[key], key);
      expect(diff, diff ? formatDifference(diff) : undefined).toBeNull();
    }
  });
});

describe(`plist roundtrip property sweep (seed=${PROPERTY_SEED}, budget=${PROPERTY_CASES} cases)`, () => {
  const rand = mulberry32(PROPERTY_SEED);
  const generated = Array.from({ length: PROPERTY_CASES }, () => generatePlistValue(rand));

  it('roundtrips every generated value through XML and binary within the supported scope', () => {
    generated.forEach((value, index) => {
      const expected = normalizePlist(value);
      const context = () =>
        `seed=${PROPERTY_SEED} case=#${index} value=${JSON.stringify(expected)?.slice(0, 2000)}`;
      const xmlDiff = firstDifference(expected, normalizePlist(plist.parse(plist.build(value))));
      expect(xmlDiff, xmlDiff ? `${context()} xml: ${formatDifference(xmlDiff)}` : undefined).toBeNull();
      const binDiff = firstDifference(expected, normalizePlist(plist.parseBinary(plist.buildBinary(value))));
      expect(binDiff, binDiff ? `${context()} binary: ${formatDifference(binDiff)}` : undefined).toBeNull();
    });
  });

  it('generates the identical case stream for the fixed seed (reproducible)', () => {
    const replayRand = mulberry32(PROPERTY_SEED);
    const replay = Array.from({ length: PROPERTY_CASES }, () => generatePlistValue(replayRand));
    const diff = firstDifference(generated.map(normalizePlist), replay.map(normalizePlist));
    expect(diff, diff ? formatDifference(diff) : undefined).toBeNull();
  });

  it('builds deterministic output for every generated value', () => {
    generated.forEach((value, index) => {
      expect(plist.build(value), `case=#${index}: XML build not deterministic`).toBe(plist.build(value));
      const first = Buffer.from(plist.buildBinary(value)).toString('hex');
      const second = Buffer.from(plist.buildBinary(value)).toString('hex');
      expect(first, `case=#${index}: binary build not deterministic`).toBe(second);
    });
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  corruptCases,
  firstDifference,
  formatDifference,
  mulberry32,
  repoRoot,
  shuffled,
  valueCases,
} from './support/plist-contracts.js';
import {
  GateViolation,
  computeRoundtripResults,
  countGateWorkspaces,
  extractTarball,
  firstManifestDifference,
  hashManifest,
  loadEntries,
  packTarball,
  runGate,
  setupConsumer,
  verifyDeclaredPathsExist,
  verifySourceAndDeclarationMaps,
  withDOMParserShim,
  type GateSummary,
} from './support/publish-gate.js';

const GATE_TIMEOUT = 180_000;

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
}

describe('publish tarball gate (plist npm package cross-entry roundtrip)', () => {
  let gitStatusBefore: string;
  let packDir: string;
  let tarballA: string;
  let tarballB: string;
  let packageDirA: string;
  let summaryA: GateSummary;

  beforeAll(async () => {
    gitStatusBefore = gitStatus();
    // Build through the repo's own toolchain so the tarball reflects src/.
    execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', repoRoot], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-pack-'));
    tarballA = packTarball(packDir);
    tarballB = packTarball(packDir);
    packageDirA = extractTarball(tarballA, path.join(packDir, 'extract-a'));
    summaryA = await runGate(tarballA);
  }, GATE_TIMEOUT);

  afterAll(() => {
    fs.rmSync(packDir, { recursive: true, force: true });
  });

  it('two consecutive npm pack runs produce an identical file manifest', () => {
    const packageDirB = extractTarball(tarballB, path.join(packDir, 'extract-b'));
    const diff = firstManifestDifference(hashManifest(packageDirA), hashManifest(packageDirB));
    expect(
      diff,
      diff ? `pack manifests diverge: ${formatDifference(diff)}` : undefined,
    ).toBeNull();
    expect(path.basename(tarballA)).toBe(path.basename(tarballB));
  });

  it('rejects a source directory as the acceptance object, then recovers on the packed tarball', async () => {
    const workspacesBefore = countGateWorkspaces();
    let violation: GateViolation | undefined;
    try {
      await runGate(repoRoot);
    } catch (error) {
      violation = error as GateViolation;
    }
    expect(violation).toBeInstanceOf(GateViolation);
    expect(violation!.step).toBe('acceptance-object');
    expect(violation!.message).toContain('tarball');
    // The failed run must not leave its workspace behind.
    expect(countGateWorkspaces()).toBe(workspacesBefore);
    // Recovery: the same gate on the real tarball succeeds and matches the
    // baseline summary, proving the failure left no cache/counter behind.
    const recovered = await runGate(tarballA);
    expect(recovered).toEqual(summaryA);
  }, GATE_TIMEOUT);

  it('ships every path declared in exports, main and types', () => {
    const declared = verifyDeclaredPathsExist(packageDirA);
    expect(declared).toContain('dist/index.js');
    expect(declared).toContain('dist/index.browser.js');
    expect(declared).toContain('dist/index.d.ts');
    expect(summaryA.declaredPaths).toEqual(declared);
  });

  it('ships source maps and type declaration maps for every emitted file', () => {
    const distFiles = verifySourceAndDeclarationMaps(packageDirA);
    expect(distFiles).toContain('index.js');
    expect(distFiles).toContain('index.js.map');
    expect(distFiles).toContain('index.d.ts');
    expect(distFiles).toContain('index.d.ts.map');
    expect(summaryA.distFiles).toEqual(distFiles);
  });

  it('resolves the declared CommonJS, ESM, browser and types entries from the tarball', () => {
    expect(summaryA.entries.esm).toBe('dist/index.js');
    expect(summaryA.entries.browser).toBe('dist/index.browser.js');
    expect(summaryA.entries.cjs).toBe('dist/index.js');
    expect(summaryA.entries.types).toBe('dist/index.d.ts');
    expect(summaryA.entries.cjsLoadable).toBe(true);
  });

  it('roundtrips XML and binary plists across entries and records repeatable rejections', () => {
    expect(summaryA.roundtrips.length).toBeGreaterThan(0);
    for (const c of valueCases) {
      const vias = summaryA.roundtrips.filter((r) => r.case === c.name).map((r) => r.via);
      if (c.xml !== false) expect(vias).toContain('browser.build->esm.parse');
      if (c.binary !== false) expect(vias).toContain('esm.buildBinary->browser.parseBinary');
    }
    // Every corrupted input rejected mid-gate kept the existing error layering.
    expect(summaryA.rejections.length).toBe(valueCases.length);
    for (const rejection of summaryA.rejections) {
      const corrupt = corruptCases.find((c) => c.name === rejection.name)!;
      expect({ errorName: rejection.errorName, message: rejection.message }).toEqual({
        errorName: corrupt.errorName,
        message: corrupt.message,
      });
    }
  });

  it('repeated gate runs are identical and leave no cache, counter or temp state behind', async () => {
    const workspacesBefore = countGateWorkspaces();
    const again = await runGate(tarballA);
    const third = await runGate(tarballB);
    expect(again).toEqual(summaryA);
    expect(third).toEqual(summaryA);
    expect(countGateWorkspaces()).toBe(workspacesBefore);
  }, GATE_TIMEOUT);

  it('cross-entry roundtrips stay stable under shuffled and concurrent scheduling', async () => {
    const consumerDir = path.join(packDir, 'consumer-order');
    fs.mkdirSync(consumerDir);
    setupConsumer(packageDirA, consumerDir);
    const entries = await loadEntries(consumerDir);
    await withDOMParserShim(async () => {
      const baseline = computeRoundtripResults(entries, valueCases);
      // Shuffled execution order (fixed seed) must not change any result.
      const rand = mulberry32(0x0dde5);
      for (let round = 0; round < 4; round++) {
        const reordered = shuffled(valueCases, rand);
        const results = computeRoundtripResults(entries, reordered);
        for (const key of Object.keys(baseline)) {
          const diff = firstDifference(baseline[key], results[key], key);
          expect(diff, diff ? `round ${round}: ${formatDifference(diff)}` : undefined).toBeNull();
        }
      }
      // Concurrent scheduling must not change any result either.
      const concurrent: Record<string, unknown> = {};
      await Promise.all(
        valueCases.map(async (c) => {
          Object.assign(concurrent, computeRoundtripResults(entries, [c]));
        }),
      );
      for (const key of Object.keys(baseline)) {
        const diff = firstDifference(baseline[key], concurrent[key], key);
        expect(diff, diff ? `concurrent: ${formatDifference(diff)}` : undefined).toBeNull();
      }
    });
  }, GATE_TIMEOUT);

  it('leaves the working tree clean', () => {
    expect(gitStatus()).toBe(gitStatusBefore);
  });
});

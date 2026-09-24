import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import {
  corruptCases,
  expectRepeatableRejection,
  firstDifference,
  normalizePlist,
  repoRoot,
  valueCases,
  type PlistEntry,
  type ValueCase,
} from './plist-contracts.js';

/**
 * Local gate for the actual publish tarball. All checks run against the
 * output of `npm pack`, never against the source tree, and every plist
 * operation goes through the package's declared public entries.
 */

export class GateViolation extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly evidence: Record<string, unknown>,
  ) {
    super(`[${step}] ${message} :: ${JSON.stringify(evidence)}`);
    this.name = 'GateViolation';
  }
}

export function gateAssert(
  condition: unknown,
  step: string,
  message: string,
  evidence: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new GateViolation(step, message, evidence);
}

export const GATE_WORKSPACE_PREFIX = 'plist-gate-';

export function countGateWorkspaces(): number {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(GATE_WORKSPACE_PREFIX)).length;
}

/** Run `npm pack` in the repo and return the produced tarball path. */
export function packTarball(destDir: string): string {
  const out = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const name = out.trim().split('\n').pop()!.trim();
  const tarball = path.join(destDir, name);
  gateAssert(name.endsWith('.tgz') && fs.existsSync(tarball), 'pack', 'npm pack did not produce the expected tarball', {
    stdout: out,
    destDir,
  });
  return tarball;
}

/** Extract a tarball into destDir and return the package directory. */
export function extractTarball(tarball: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', destDir]);
  const packageDir = path.join(destDir, 'package');
  gateAssert(fs.existsSync(path.join(packageDir, 'package.json')), 'extract', 'tarball did not contain package/package.json', {
    tarball,
  });
  return packageDir;
}

/** Every path a consumer can reach: exports leaves plus main/types. */
export function collectDeclaredPaths(pkgJson: Record<string, any>): string[] {
  const paths: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      paths.push(node.replace(/^\.\//, ''));
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(pkgJson.exports);
  if (typeof pkgJson.main === 'string') paths.push(pkgJson.main.replace(/^\.\//, ''));
  if (typeof pkgJson.types === 'string') paths.push(pkgJson.types.replace(/^\.\//, ''));
  return [...new Set(paths)].sort();
}

/** Verify every path declared in exports/main/types exists in the package. */
export function verifyDeclaredPathsExist(packageDir: string): string[] {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const declared = collectDeclaredPaths(pkgJson);
  const missing = declared.filter((rel) => !fs.existsSync(path.join(packageDir, rel)));
  gateAssert(missing.length === 0, 'declared-paths', 'paths declared in exports/main/types are missing from the tarball', {
    firstMissing: missing[0] ?? null,
    missing,
    declared,
  });
  return declared;
}

/** Verify each emitted file ships its source map and declaration map. */
export function verifySourceAndDeclarationMaps(packageDir: string): string[] {
  const distDir = path.join(packageDir, 'dist');
  gateAssert(fs.existsSync(distDir), 'artifact-completeness', 'tarball has no dist directory', { packageDir });
  const files = fs.readdirSync(distDir).sort();
  const missing: string[] = [];
  for (const file of files) {
    if (file.endsWith('.js')) {
      if (!files.includes(`${file}.map`)) missing.push(`${file}.map`);
      const decl = `${file.slice(0, -3)}.d.ts`;
      if (!files.includes(decl)) missing.push(decl);
    }
    if (file.endsWith('.d.ts') && !files.includes(`${file}.map`)) missing.push(`${file}.map`);
  }
  gateAssert(missing.length === 0, 'artifact-completeness', 'emitted files are missing source maps or type declarations', {
    firstMissing: missing[0] ?? null,
    missing,
    distFiles: files,
  });
  return files;
}

export interface ManifestEntry {
  path: string;
  sha256: string;
}

/** Sorted content manifest of an extracted package. */
export function hashManifest(dir: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(rel === '' ? name : `${rel}/${name}`);
    } else {
      out.push({ path: rel, sha256: createHash('sha256').update(fs.readFileSync(abs)).digest('hex') });
    }
  };
  walk('');
  return out;
}

/** First difference between two manifests, or null when identical. */
export function firstManifestDifference(a: ManifestEntry[], b: ManifestEntry[]) {
  if (a.length !== b.length) {
    return { path: '<file-count>', expected: a.length, actual: b.length };
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path) return { path: `<entry#${i}>`, expected: a[i].path, actual: b[i].path };
    if (a[i].sha256 !== b[i].sha256) {
      return { path: a[i].path, expected: a[i].sha256, actual: b[i].sha256 };
    }
  }
  return null;
}

const CONSUMER_CHECK_TS = `import { parse, build, parseBinary, buildBinary, parseOpenStep, type PlistValue } from 'plist';
const xml: string = build({ ok: true, when: new Date(0) });
const value: PlistValue = parse(xml);
const bytes: Uint8Array = buildBinary(value);
const round: PlistValue = parseBinary(bytes);
const openStep: PlistValue = parseOpenStep('{ a = 1; }');
void round;
void openStep;
`;

/**
 * Install the extracted package into an isolated consumer directory so that
 * Node's own resolution (not our path math) picks the entries. Runtime
 * dependencies are symlinked from the repo's installed node_modules.
 */
export function setupConsumer(packageDir: string, consumerDir: string): void {
  const nm = path.join(consumerDir, 'node_modules');
  fs.mkdirSync(path.join(nm, '@xmldom'), { recursive: true });
  fs.cpSync(packageDir, path.join(nm, 'plist'), { recursive: true });
  for (const dep of ['@xmldom/xmldom', 'xmlbuilder']) {
    fs.symlinkSync(path.join(repoRoot, 'node_modules', dep), path.join(nm, dep), 'dir');
  }
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'plist-gate-consumer', private: true, type: 'module' }),
  );
  fs.writeFileSync(path.join(consumerDir, 'check.ts'), CONSUMER_CHECK_TS);
}

/** Type-check a consumer against the packed types entry using the repo tsc. */
export function verifyTypesEntry(consumerDir: string): void {
  const tscBin = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(
      process.execPath,
      [tscBin, '--noEmit', '--strict', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'check.ts'],
      { cwd: consumerDir, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    throw new GateViolation('types-entry', 'consumer failed to type-check against the packed types entry', {
      stdout: err.stdout ?? null,
      stderr: err.stderr ?? null,
    });
  }
}

export interface LoadedEntries {
  esm: PlistEntry;
  browser: PlistEntry;
  cjs?: PlistEntry;
  paths: { esm: string; browser: string; cjs: string; types: string };
}

/** Resolve and load the declared ESM, browser, CJS and types entries. */
export async function loadEntries(consumerDir: string): Promise<LoadedEntries> {
  const pkgDir = path.join(consumerDir, 'node_modules', 'plist');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const dot = pkgJson.exports['.'];
  const esmRel = dot.import.default.replace(/^\.\//, '');
  const browserRel = dot.browser.default.replace(/^\.\//, '');
  const defaultRel = dot.default.default.replace(/^\.\//, '');
  const typesRel = dot.import.types.replace(/^\.\//, '');

  const require = createRequire(path.join(consumerDir, 'index.cjs'));
  const cjsResolved = fs.realpathSync(require.resolve('plist'));
  gateAssert(
    cjsResolved === fs.realpathSync(path.join(pkgDir, defaultRel)),
    'cjs-entry',
    'CommonJS resolution did not land on the declared default entry',
    { cjsResolved, declared: defaultRel },
  );
  let cjs: PlistEntry | undefined;
  try {
    cjs = require('plist') as PlistEntry;
  } catch (error) {
    // Node < 22 cannot require() an ES module; resolution above still gates the path.
    gateAssert(
      (error as NodeJS.ErrnoException)?.code === 'ERR_REQUIRE_ESM',
      'cjs-entry',
      'loading the CommonJS-resolved entry failed unexpectedly',
      { message: String((error as Error)?.message ?? error) },
    );
  }

  const esm = (await import(pathToFileURL(path.join(pkgDir, esmRel)).href)) as PlistEntry;
  const browser = (await import(pathToFileURL(path.join(pkgDir, browserRel)).href)) as PlistEntry;
  for (const [label, mod] of [['esm', esm], ['browser', browser], ['cjs', cjs]] as const) {
    if (!mod) continue;
    for (const fn of ['parse', 'build', 'parseBinary', 'buildBinary'] as const) {
      gateAssert(typeof mod[fn] === 'function', 'entry-shape', `entry is missing ${fn}()`, { entry: label });
    }
  }
  return { esm, browser, cjs, paths: { esm: esmRel, browser: browserRel, cjs: defaultRel, types: typesRel } };
}

/** The browser entry expects a DOM; supply the repo's DOMParser, then restore. */
export async function withDOMParserShim<T>(fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const had = 'DOMParser' in g;
  const prev = g.DOMParser;
  g.DOMParser = DOMParser;
  try {
    return await fn();
  } finally {
    if (had) g.DOMParser = prev;
    else delete g.DOMParser;
  }
}

/** The (case, via) plan for one value case across the loaded entries. */
export function roundtripPlan(entries: LoadedEntries, c: ValueCase): [string, () => unknown][] {
  const plan: [string, () => unknown][] = [];
  if (c.xml !== false) {
    plan.push(['esm.build->esm.parse', () => entries.esm.parse(entries.esm.build(c.value))]);
    plan.push(['browser.build->esm.parse', () => entries.esm.parse(entries.browser.build(c.value))]);
    plan.push(['esm.build->browser.parse', () => entries.browser.parse(entries.esm.build(c.value))]);
    if (entries.cjs) {
      plan.push(['esm.build->cjs.parse', () => entries.cjs!.parse(entries.esm.build(c.value))]);
    }
  }
  if (c.binary !== false) {
    plan.push(['esm.buildBinary->browser.parseBinary', () => entries.browser.parseBinary(entries.esm.buildBinary(c.value))]);
    plan.push(['browser.buildBinary->esm.parseBinary', () => entries.esm.parseBinary(entries.browser.buildBinary(c.value))]);
  }
  return plan;
}

/** Normalised roundtrip results keyed `${case}::${via}`, in case order. */
export function computeRoundtripResults(entries: LoadedEntries, cases: ValueCase[]): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const c of cases) {
    for (const [via, run] of roundtripPlan(entries, c)) {
      results[`${c.name}::${via}`] = normalizePlist(run());
    }
  }
  return results;
}

export interface GateSummary {
  tarballName: string;
  fileCount: number;
  manifestSha256: string;
  declaredPaths: string[];
  distFiles: string[];
  entries: { esm: string; browser: string; cjs: string; types: string; cjsLoadable: boolean };
  roundtrips: { case: string; via: string }[];
  rejections: { name: string; errorName: string; message: string }[];
}

/**
 * Run the full publish gate against one tarball. Self-contained: allocates
 * its own workspace and always cleans it up, so failed runs cannot leak
 * state into later ones. The returned summary contains only relative paths
 * and content hashes, making repeated runs comparable.
 */
export async function runGate(tarballPath: string): Promise<GateSummary> {
  const stat = fs.existsSync(tarballPath) ? fs.statSync(tarballPath) : null;
  gateAssert(
    stat?.isFile() === true && tarballPath.endsWith('.tgz'),
    'acceptance-object',
    'acceptance target must be a packed .tgz tarball (npm pack output), not a source directory',
    { received: tarballPath, exists: stat !== null, isDirectory: stat?.isDirectory() ?? false },
  );
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), GATE_WORKSPACE_PREFIX));
  try {
    const packageDir = extractTarball(tarballPath, workspace);
    const declaredPaths = verifyDeclaredPathsExist(packageDir);
    const distFiles = verifySourceAndDeclarationMaps(packageDir);
    const manifest = hashManifest(packageDir);

    const consumerDir = path.join(workspace, 'consumer');
    fs.mkdirSync(consumerDir);
    setupConsumer(packageDir, consumerDir);
    verifyTypesEntry(consumerDir);
    const entries = await loadEntries(consumerDir);

    const roundtrips: GateSummary['roundtrips'] = [];
    const rejections: GateSummary['rejections'] = [];
    await withDOMParserShim(() => {
      let corruptIndex = 0;
      for (const c of valueCases) {
        const expected = normalizePlist(c.value);
        for (const [via, run] of roundtripPlan(entries, c)) {
          const diff = firstDifference(expected, normalizePlist(run()));
          gateAssert(!diff, 'cross-entry-roundtrip', 'roundtrip result diverged from the input value', {
            case: c.name,
            via,
            diff,
          });
          roundtrips.push({ case: c.name, via });
        }
        // Inject a recoverable failure between successful calls; the next
        // iteration must observe an unpolluted library.
        const corrupt = corruptCases[corruptIndex++ % corruptCases.length];
        rejections.push(expectRepeatableRejection(entries.esm, corrupt, `gate after case ${c.name}`));
      }
    });

    return {
      tarballName: path.basename(tarballPath),
      fileCount: manifest.length,
      manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      declaredPaths,
      distFiles,
      entries: { ...entries.paths, cjsLoadable: entries.cjs !== undefined },
      roundtrips,
      rejections,
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

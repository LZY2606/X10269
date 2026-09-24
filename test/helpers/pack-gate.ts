/**
 * Shared helpers for the "pack tarball" acceptance gate.
 *
 * Every runtime object exercised by the gate tests is obtained from the
 * packed npm tarball (extracted to a temp dir), never from `src/` or the
 * repo `dist/` directly, so the acceptance object is always the artifact
 * that would be published.
 */
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES_DIR = join(REPO_ROOT, 'test/fixtures/pack-gate');

/** Error raised by the gate harness itself, always tagged with the stage. */
export class PackGateError extends Error {
	readonly stage: string;
	constructor(stage: string, message: string, options?: { cause?: unknown }) {
		super(`[${stage}] ${message}`, options);
		this.name = 'PackGateError';
		this.stage = stage;
	}
}

export interface PackManifestEntry {
	path: string;
	size: number;
}

export interface PackResult {
	tarball: string;
	files: PackManifestEntry[];
}

export interface PackGateContext {
	tmpRoot: string;
	tarball1: string;
	tarball2: string;
	manifest1: PackManifestEntry[];
	manifest2: PackManifestEntry[];
	pkgDir1: string;
	pkgDir2: string;
	gitStatusBefore: string;
}

declare module 'vitest' {
	interface ProvidedContext {
		packGate: PackGateContext;
	}
}

/** Run `npm pack` into `destDir` and return the tarball path + file manifest. */
export function runNpmPack(destDir: string): PackResult {
	mkdirSync(destDir, { recursive: true });
	const stdout = execFileSync(
		'npm',
		['pack', '--pack-destination', destDir, '--json'],
		{ cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
	);
	let parsed: Array<{ filename: string; files: Array<{ path: string; size: number }> }>;
	try {
		parsed = JSON.parse(stdout);
	} catch (cause) {
		throw new PackGateError('pack', `npm pack --json produced unparseable output: ${stdout.slice(0, 200)}`, { cause });
	}
	const files = parsed[0].files
		.map((f) => ({ path: f.path, size: f.size }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { tarball: join(destDir, parsed[0].filename), files };
}

/**
 * Extract a tarball into `finalDir` atomically: a staging directory is
 * extracted first and renamed into place only after the expected package
 * layout is verified. On any failure the staging directory is removed so
 * no half-extracted state survives.
 */
export function extractTarballAtomic(tarball: string, finalDir: string): void {
	if (!existsSync(tarball)) {
		throw new PackGateError('extract', `tarball does not exist: ${tarball}`);
	}
	const staging = `${finalDir}.staging-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	rmSync(finalDir, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		execFileSync('tar', ['-xzf', tarball, '-C', staging], { stdio: 'pipe' });
		const pkgJson = join(staging, 'package', 'package.json');
		if (!existsSync(pkgJson)) {
			throw new PackGateError('extract', `missing package/package.json in ${tarball}`);
		}
		renameSync(join(staging, 'package'), finalDir);
	} catch (cause) {
		rmSync(staging, { recursive: true, force: true });
		if (cause instanceof PackGateError) throw cause;
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new PackGateError('extract', `failed to extract ${tarball}: ${detail}`, { cause });
	}
	rmSync(staging, { recursive: true, force: true });
}

/**
 * Symlink the packed package's declared dependencies from the repo's
 * lockfile-installed node_modules, simulating an installed consumer
 * without network access.
 */
export function linkDependencies(pkgDir: string): void {
	const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
	for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
		const target = join(REPO_ROOT, 'node_modules', dep);
		if (!existsSync(target)) {
			throw new PackGateError('link', `dependency ${dep} not installed at ${target}`);
		}
		const link = join(pkgDir, 'node_modules', dep);
		mkdirSync(dirname(link), { recursive: true });
		rmSync(link, { recursive: true, force: true });
		symlinkSync(target, link, 'junction');
	}
}

export interface PlistModule {
	parse: (xml: string | Uint8Array | ArrayBuffer) => unknown;
	parseOpenStep: (input: string) => unknown;
	parseBinary: (data: Uint8Array) => unknown;
	build: (obj: unknown, opts?: Record<string, unknown>) => string;
	buildBinary: (obj: unknown) => Uint8Array;
}

export interface PackedEntrypoints {
	esm: PlistModule;
	browser: PlistModule;
	cjs: PlistModule;
}

let domParserInstalled = false;

async function ensureDOMParser(): Promise<void> {
	if (domParserInstalled) return;
	const g = globalThis as Record<string, unknown>;
	if (typeof g.DOMParser !== 'function') {
		const xmldom = await import('@xmldom/xmldom');
		g.DOMParser = xmldom.DOMParser;
	}
	domParserInstalled = true;
}

/**
 * Load the packed package through each declared public entry condition:
 * ESM (`import`), browser (`browser`) and CommonJS consumption (`require`
 * of the `default` condition, supported by Node >= 22 for ESM graphs).
 */
export async function loadPackedPackage(pkgDir: string): Promise<PackedEntrypoints> {
	await ensureDOMParser();
	const esmUrl = pathToFileURL(join(pkgDir, 'dist/index.js')).href;
	const browserUrl = pathToFileURL(join(pkgDir, 'dist/index.browser.js')).href;
	let esm: PlistModule;
	let browser: PlistModule;
	let cjs: PlistModule;
	try {
		esm = (await import(esmUrl)) as PlistModule;
	} catch (cause) {
		throw new PackGateError('load:esm', `cannot import ${esmUrl}`, { cause });
	}
	try {
		browser = (await import(browserUrl)) as PlistModule;
	} catch (cause) {
		throw new PackGateError('load:browser', `cannot import ${browserUrl}`, { cause });
	}
	try {
		const require = createRequire(join(pkgDir, 'package.json'));
		cjs = require('./dist/index.js') as PlistModule;
	} catch (cause) {
		throw new PackGateError('load:cjs', `cannot require dist/index.js from ${pkgDir}`, { cause });
	}
	return { esm, browser, cjs };
}

/** Extract + link + load a tarball in one step (the full acceptance flow). */
export async function loadPackageFromTarball(
	tarball: string,
	pkgDir: string,
): Promise<PackedEntrypoints> {
	extractTarballAtomic(tarball, pkgDir);
	linkDependencies(pkgDir);
	return loadPackedPackage(pkgDir);
}

/** Recursively collect every file path referenced by an exports map. */
export function collectExportsPaths(exportsField: unknown, prefix = 'exports'): string[] {
	const out: string[] = [];
	const walk = (node: unknown, where: string): void => {
		if (typeof node === 'string') {
			out.push(node);
		} else if (node && typeof node === 'object') {
			for (const [key, value] of Object.entries(node)) {
				walk(value, `${where}.${key}`);
			}
		} else {
			throw new PackGateError('exports', `unexpected ${typeof node} at ${where}`);
		}
	};
	walk(exportsField, prefix);
	return out;
}

/** sha256 of every file under `dir`, keyed by posix-relative path, sorted. */
export function hashTree(dir: string): Array<{ path: string; sha256: string }> {
	const out: Array<{ path: string; sha256: string }> = [];
	const walk = (current: string, rel: string): void => {
		for (const entry of readdirSync(current).sort()) {
			if (entry === 'node_modules') continue;
			const full = join(current, entry);
			const relPath = rel ? `${rel}/${entry}` : entry;
			if (statSync(full).isDirectory()) {
				walk(full, relPath);
			} else {
				const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex');
				out.push({ path: relPath, sha256 });
			}
		}
	};
	walk(dir, '');
	return out;
}

export interface Difference {
	path: string;
	expected: string;
	actual: string;
}

function describe(value: unknown): string {
	if (value instanceof Date) return `Date(${value.toISOString()})`;
	if (value instanceof Uint8Array) return `Uint8Array[${value.length}](${Array.from(value.slice(0, 8)).join(',')}${value.length > 8 ? ',…' : ''})`;
	if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);
	try {
		return JSON.stringify(value)?.slice(0, 120) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Find the first semantic difference between two plist values, preserving
 * object key order (key order is part of the contract under test).
 * Returns null when the values are equivalent.
 */
export function firstDifference(actual: unknown, expected: unknown, path = '$'): Difference | null {
	const fail = (p: string): Difference => ({ path: p, expected: describe(expected), actual: describe(actual) });
	if (expected instanceof Date) {
		if (!(actual instanceof Date)) return fail(path);
		if (actual.getTime() !== expected.getTime()) return fail(path);
		return null;
	}
	if (expected instanceof Uint8Array || expected instanceof ArrayBuffer) {
		const expectedBytes = expected instanceof Uint8Array ? expected : new Uint8Array(expected);
		const actualBytes = actual instanceof Uint8Array ? actual : actual instanceof ArrayBuffer ? new Uint8Array(actual) : null;
		if (!actualBytes) return fail(path);
		if (actualBytes.length !== expectedBytes.length) return fail(path);
		for (let i = 0; i < expectedBytes.length; i++) {
			if (actualBytes[i] !== expectedBytes[i]) return fail(`${path}[byte ${i}]`);
		}
		return null;
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return fail(path);
		if (actual.length !== expected.length) return fail(`${path}.length`);
		for (let i = 0; i < expected.length; i++) {
			const diff = firstDifference(actual[i], expected[i], `${path}[${i}]`);
			if (diff) return diff;
		}
		return null;
	}
	if (expected !== null && typeof expected === 'object') {
		if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return fail(path);
		const expectedKeys = Object.keys(expected);
		const actualKeys = Object.keys(actual);
		if (actualKeys.length !== expectedKeys.length || actualKeys.some((k, i) => k !== expectedKeys[i])) {
			return {
				path: `${path}.keys`,
				expected: JSON.stringify(expectedKeys),
				actual: JSON.stringify(actualKeys),
			};
		}
		for (const key of expectedKeys) {
			const diff = firstDifference(
				(actual as Record<string, unknown>)[key],
				(expected as Record<string, unknown>)[key],
				`${path}.${JSON.stringify(key)}`,
			);
			if (diff) return diff;
		}
		return null;
	}
	if (typeof expected === 'number' && typeof actual === 'number') {
		return Object.is(actual, expected) ? null : fail(path);
	}
	return Object.is(actual, expected) ? null : fail(path);
}

export function formatDifference(diff: Difference): string {
	return `first violation at ${diff.path}: expected ${diff.expected}, got ${diff.actual}`;
}

/** Deterministic PRNG (mulberry32) so property cases are reproducible. */
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

const STRING_ALPHABET = 'ab&<>"\'é中🙂 xZ09';

function randomString(rand: () => number, maxLen: number): string {
	const len = Math.floor(rand() * (maxLen + 1));
	let out = '';
	for (let i = 0; i < len; i++) {
		out += STRING_ALPHABET[Math.floor(rand() * STRING_ALPHABET.length)];
	}
	return out;
}

export interface GeneratorBudget {
	maxDepth: number;
	maxLength: number;
	maxStringLength: number;
	maxDataLength: number;
}

export const DEFAULT_BUDGET: GeneratorBudget = {
	maxDepth: 4,
	maxLength: 6,
	maxStringLength: 12,
	maxDataLength: 8,
};

/**
 * Generate a random plist value within the library's supported round-trip
 * scope for both XML and binary formats: dict keys are non-empty strings
 * (never `__proto__`), integers stay within 32 bits, dates use whole-second
 * precision (XML <date> granularity), reals are finite doubles.
 */
export function generateValue(rand: () => number, budget: GeneratorBudget, depth = 0): unknown {
	const leafKinds = 6;
	const kindMax = depth >= budget.maxDepth ? leafKinds : 9;
	const kind = Math.floor(rand() * kindMax);
	switch (kind) {
		case 0:
			return randomString(rand, budget.maxStringLength);
		case 1:
			return Math.floor(rand() * 0x1_0000_0000) - 0x8000_0000;
		case 2:
			return Math.round((rand() * 2 - 1) * 1e6) / 1e3;
		case 3:
			return rand() < 0.5;
		case 4:
			return new Date(Math.floor(rand() * 2_000_000_000) * 1000);
		case 5: {
			const len = Math.floor(rand() * (budget.maxDataLength + 1));
			const bytes = new Uint8Array(len);
			for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256);
			return bytes;
		}
		case 6:
		case 7: {
			const len = Math.floor(rand() * (budget.maxLength + 1));
			const arr: unknown[] = [];
			for (let i = 0; i < len; i++) arr.push(generateValue(rand, budget, depth + 1));
			return arr;
		}
		default: {
			const len = Math.floor(rand() * (budget.maxLength + 1));
			const obj: Record<string, unknown> = {};
			for (let i = 0; i < len; i++) {
				let key = randomString(rand, budget.maxStringLength);
				if (key === '' || key === '__proto__' || key in obj) key = `k${i}`;
				obj[key] = generateValue(rand, budget, depth + 1);
			}
			return obj;
		}
	}
}

/** Deterministic in-place shuffle driven by the provided PRNG. */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

export function freshTempDir(parent: string, prefix: string): string {
	const base = join(parent, `${prefix}${process.pid}-${Math.floor(Math.random() * 1e9)}`);
	mkdirSync(base, { recursive: true });
	return base;
}

export { join, sep };

/** Lossless canonical form: Dates and byte arrays become tagged objects. */
export function canonical(value: unknown): unknown {
	if (value instanceof Date) return { $type: 'date', value: value.toISOString() };
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
		return { $type: 'data', value: Array.from(bytes) };
	}
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) out[key] = canonical(val);
		return out;
	}
	return value;
}

/** Deterministic canonical serialization (object key order preserved). */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

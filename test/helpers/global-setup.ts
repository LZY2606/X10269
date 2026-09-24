/**
 * Vitest global setup for the pack-tarball gate.
 *
 * Builds the package, runs `npm pack` twice (determinism gate), extracts
 * both tarballs atomically into a temp root and provides the locations to
 * test workers. Everything the tests touch comes from the packed tarball,
 * never from the source tree.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provide } from 'vitest';
import {
	extractTarballAtomic,
	linkDependencies,
	REPO_ROOT,
	runNpmPack,
	type PackGateContext,
} from './pack-gate.js';

export default async function setup(): Promise<() => void> {
	execFileSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

	const tmpRoot = mkdtempSync(join(tmpdir(), 'plist-pack-gate-'));
	const pack1 = runNpmPack(join(tmpRoot, 'pack1'));
	const pack2 = runNpmPack(join(tmpRoot, 'pack2'));

	const pkgDir1 = join(tmpRoot, 'pkg1');
	const pkgDir2 = join(tmpRoot, 'pkg2');
	extractTarballAtomic(pack1.tarball, pkgDir1);
	extractTarballAtomic(pack2.tarball, pkgDir2);
	linkDependencies(pkgDir1);
	linkDependencies(pkgDir2);

	const gitStatusBefore = execFileSync('git', ['status', '--porcelain'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
	});

	const context: PackGateContext = {
		tmpRoot,
		tarball1: pack1.tarball,
		tarball2: pack2.tarball,
		manifest1: pack1.files,
		manifest2: pack2.files,
		pkgDir1,
		pkgDir2,
		gitStatusBefore,
	};
	provide('packGate', context);

	return async () => {
		rmSync(tmpRoot, { recursive: true, force: true });
	};
}

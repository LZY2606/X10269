/**
 * plist.js 发布包门禁：对真实 `npm pack` 产出的 tarball，
 * 从 package.json 声明的 CommonJS / ESM / 类型入口分别进入，
 * 完成 XML / binary plist 的构建、解析与跨入口往返，并核验：
 *   - 两次 pack 的文件清单与逐文件内容哈希一致
 *   - exports / main / types 中每个路径都存在，dist 产物携带 source map 与类型声明
 *   - 时间、Data、UID、大整数、key 顺序按库现有支持范围往返一致
 *   - 中途注入损坏输入后恢复重试，结果与基线完全一致（失败原子性 / 无残留状态）
 *   - 改变执行顺序、并发调度不改变结果（确定性）
 *   - 固定 seed + 规模预算的性质测试
 *   - 测试结束后工作树保持干净
 *
 * 所有断言都只通过 tarball 内 dist 的公开入口（parse/parseBinary/parseOpenStep/build/buildBinary）
 * 与 package.json 的 exports 解析进入，不直接构造内部对象。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { PlistValue } from '../src/index.js';

const repoRoot = join(import.meta.dirname, '..');

/* ------------------------------------------------------------------ */
/* tarball：解析 ustar 清单 + 解包（只依赖 node 内置能力）              */
/* ------------------------------------------------------------------ */

interface TarEntry {
  name: string;
  size: number;
  data: Buffer;
}

function readTarball(tgzPath: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(tgzPath));
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const name = buf.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    if (name === '') break;
    const sizeField = buf
      .toString('utf8', offset + 124, offset + 136)
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeField, 8);
    const prefix = buf.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const typeFlag = String.fromCharCode(buf[offset + 156]);
    entries.push({
      name: full,
      size,
      data:
        typeFlag === '5'
          ? Buffer.alloc(0)
          : Buffer.from(buf.subarray(offset + 512, offset + 512 + size)),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function manifestOf(entries: TarEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.name, createHash('sha256').update(entry.data).digest('hex'));
  }
  return map;
}

function extractTarball(entries: TarEntry[], destination: string): void {
  for (const entry of entries) {
    const relative = entry.name.replace(/^[^/]+\//, '');
    if (relative === '') continue;
    const target = join(destination, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, entry.data);
  }
}

/* ------------------------------------------------------------------ */
/* 规范编码：把 PlistValue 变成可跨进程比较的 JSON（保留 key 顺序）     */
/* ------------------------------------------------------------------ */

interface Canon {
  t: string;
  v: unknown;
  keys?: string[];
}

function enc(value: unknown): Canon {
  if (value instanceof Date) return { t: 'date', v: value.toISOString() };
  if (value instanceof Uint8Array) {
    return {
      t: 'data',
      v: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    };
  }
  if (typeof value === 'bigint') return { t: 'bigint', v: String(value) };
  if (Array.isArray(value)) return { t: 'array', v: value.map(enc) };
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const body: Record<string, Canon> = {};
    for (const key of keys) body[key] = enc((value as Record<string, unknown>)[key]);
    return { t: 'dict', keys, v: body };
  }
  if (typeof value === 'number' && Object.is(value, -0)) return { t: 'number', v: 0 };
  return { t: typeof value, v };
}

/**
 * 库现有支持范围：bigint 只在构建时作为输入，解析回到 number。
 * 比较往返结果时把 bigint 归一化为 number，其余保持精确类型区分。
 */
function semantic(canon: Canon): Canon {
  if (canon.t === 'bigint') return { t: 'number', v: Number(canon.v as string) };
  if (canon.t === 'array') {
    return { t: 'array', v: (canon.v as Canon[]).map(semantic) };
  }
  if (canon.t === 'dict') {
    const body: Record<string, Canon> = {};
    for (const key of canon.keys ?? []) {
      body[key] = semantic((canon.v as Record<string, Canon>)[key]);
    }
    return { t: 'dict', keys: canon.keys, v: body };
  }
  return canon;
}

function semanticJson(value: unknown): string {
  return JSON.stringify(semantic(enc(value)));
}

/* ------------------------------------------------------------------ */
/* 固定 fixture：XML entity、binary object graph、Buffer/Data、date、 */
/* 嵌套数组、UID、大整数、key 顺序                                     */
/* ------------------------------------------------------------------ */

interface Fixture {
  id: string;
  /** 为 false 时只走 binary 路径（例如毫秒精度 Date，XML date 按整秒输出） */
  xmlSafe: boolean;
  value: PlistValue;
}

const fixtures: Fixture[] = [
  {
    id: 'xml-entity',
    xmlSafe: true,
    value: {
      amp: 'Fish & Chips',
      tags: '<tag attr="q">\'apos\' & "quot"</tag>',
      unicode: 'héllo → 世界 🍎',
      ampSequence: '&lt;&gt;&amp;&quot;&apos;',
    },
  },
  {
    id: 'binary-object-graph',
    xmlSafe: true,
    value: {
      app: {
        name: 'Demo',
        version: 2,
        ratio: 0.5,
        flags: [true, false],
        meta: {
          tags: ['alpha', 'beta'],
          nested: { deep: { leaf: 'x', order: [1, 2, 3] } },
          emptyDict: {},
          emptyArray: [],
        },
      },
      nothing: null,
    },
  },
  {
    id: 'buffer-data',
    xmlSafe: true,
    value: {
      full: Uint8Array.from({ length: 256 }, (_, i) => i),
      header: new Uint8Array([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74]),
      empty: new Uint8Array(0),
    },
  },
  {
    id: 'date-seconds',
    xmlSafe: true,
    value: {
      created: new Date('2024-02-29T12:34:56Z'),
      epoch2001: new Date('2001-01-01T00:00:00Z'),
    },
  },
  {
    id: 'date-milliseconds-binary-only',
    xmlSafe: false,
    value: { stamp: new Date('2024-02-29T12:34:56.789Z') },
  },
  {
    id: 'nested-arrays',
    xmlSafe: true,
    value: [[['deep'], []], [[1], [2, [3, [4]]]], 'tail'],
  },
  {
    id: 'uid',
    xmlSafe: true,
    value: {
      single: { UID: 42 },
      list: [{ UID: 1 }, { UID: 255 }, { UID: 65535 }],
    },
  },
  {
    id: 'bigint',
    xmlSafe: true,
    // bigint 是构建输入；解析按现有实现回到 number。
    // beyondSafe 的 number 舍入与 8 字节整数解析路径一致（现有支持范围）。
    value: {
      safe: 9007199254740991n,
      beyondSafe: 1234567890123456789n,
      negative: -42n,
    } as unknown as PlistValue,
  },
  {
    id: 'key-order',
    xmlSafe: true,
    value: { zebra: 1, Apple: 2, mango: 3, 'mixed-key': 4 },
  },
];

/* ------------------------------------------------------------------ */
/* 性质测试：固定 seed + 规模预算                                       */
/* ------------------------------------------------------------------ */

const PROPERTY_CASES = 64;
const PROPERTY_SEED = 0xc0ffee;
const PROPERTY_MAX_DEPTH = 4;
const PROPERTY_MAX_WIDTH = 5;
const STRING_ALPHABET = "abXYZ &<>\"'é中🍎-0_";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function randomString(rand: () => number): string {
  const length = Math.floor(rand() * 10);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += STRING_ALPHABET[Math.floor(rand() * STRING_ALPHABET.length)];
  }
  return out;
}

function randomLeaf(rand: () => number): PlistValue {
  const kind = Math.floor(rand() * 7);
  switch (kind) {
    case 0:
      return randomString(rand);
    case 1:
      return Math.floor((rand() * 2 - 1) * Number.MAX_SAFE_INTEGER);
    case 2:
      return (rand() - 0.5) * 2 ** 30;
    case 3:
      return rand() < 0.5;
    case 4: {
      // 整秒 Date：XML 与 binary 都能精确往返
      const ms = 978307200000 + (rand() - 0.5) * 2 * 40 * 365.25 * 86400_000;
      return new Date(Math.floor(ms / 1000) * 1000);
    }
    case 5: {
      const length = Math.floor(rand() * 17);
      return Uint8Array.from({ length }, () => Math.floor(rand() * 256));
    }
    default:
      return null;
  }
}

function generateValue(rand: () => number, depth: number): PlistValue {
  if (depth >= PROPERTY_MAX_DEPTH) {
    return randomLeaf(rand);
  }
  const choice = rand();
  if (choice < 0.45) {
    const length = Math.floor(rand() * (PROPERTY_MAX_WIDTH + 1));
    return Array.from({ length }, () => generateValue(rand, depth + 1));
  }
  if (choice < 0.75) {
    const length = Math.floor(rand() * (PROPERTY_MAX_WIDTH + 1));
    const dict: Record<string, PlistValue> = {};
    for (let i = 0; i < length; i++) {
      let key = `k${i}-` + randomString(rand).replace(/[&<>"']/g, 'x');
      if (key === '__proto__') key = 'proto';
      dict[key] = generateValue(rand, depth + 1);
    }
    return dict;
  }
  return randomLeaf(rand);
}

/* ------------------------------------------------------------------ */
/* 子进程任务脚本：分别以 ESM 与 CJS 入口加载 tarball 中的 plist。     */
/* 每个 job 独立 try/catch，失败不会污染同进程内后续 job。             */
/* ------------------------------------------------------------------ */

const JOB_LOGIC = [
  'function dec(v) {',
  '  if (v && typeof v === "object" && typeof v.t === "string") {',
  '    if (v.t === "date") return new Date(v.v);',
  '    if (v.t === "data") return new Uint8Array(Buffer.from(v.v, "base64"));',
  '    if (v.t === "bigint") return BigInt(v.v);',
  '    if (v.t === "array") return v.v.map(dec);',
  '    if (v.t === "dict") {',
  '      const o = {};',
  '      for (const k of v.keys) o[k] = dec(v.v[k]);',
  '      return o;',
  '    }',
  '    return v.v;',
  '  }',
  '  return v;',
  '}',
  'function enc(v) {',
  '  if (v instanceof Date) return { t: "date", v: v.toISOString() };',
  '  if (v instanceof Uint8Array) {',
  '    return { t: "data", v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };',
  '  }',
  '  if (typeof v === "bigint") return { t: "bigint", v: String(v) };',
  '  if (Array.isArray(v)) return { t: "array", v: v.map(enc) };',
  '  if (v !== null && typeof v === "object") {',
  '    const keys = Object.keys(v);',
  '    const body = {};',
  '    for (const k of keys) body[k] = enc(v[k]);',
  '    return { t: "dict", keys: keys, v: body };',
  '  }',
  '  if (typeof v === "number" && Object.is(v, -0)) return { t: "number", v: 0 };',
  '  return { t: typeof v, v: v };',
  '}',
  'const [jobsPath, outPath] = process.argv.slice(2);',
  'const jobs = JSON.parse(readFileSync(jobsPath, "utf8"));',
  'const results = jobs.map((job) => {',
  '  try {',
  '    let result;',
  '    if (job.action === "buildXml") {',
  '      const xml = plist.build(dec(job.input));',
  '      writeFileSync(job.outFile, xml);',
  '      result = { sha256: createHash("sha256").update(xml).digest("hex") };',
  '    } else if (job.action === "buildBinary") {',
  '      const bytes = plist.buildBinary(dec(job.input));',
  '      writeFileSync(job.outFile, Buffer.from(bytes));',
  '      result = { sha256: createHash("sha256").update(bytes).digest("hex") };',
  '    } else if (job.action === "parseXmlFile") {',
  '      result = enc(plist.parse(readFileSync(job.inputFile, "utf8")));',
  '    } else if (job.action === "parseBinaryFile") {',
  '      result = enc(plist.parseBinary(new Uint8Array(readFileSync(job.inputFile))));',
  '    } else if (job.action === "parseAutoFile") {',
  '      result = enc(plist.parse(new Uint8Array(readFileSync(job.inputFile))));',
  '    } else {',
  '      throw new Error("unknown action: " + job.action);',
  '    }',
  '    return { id: job.id, ok: true, result: result };',
  '  } catch (err) {',
  '    return {',
  '      id: job.id,',
  '      ok: false,',
  '      error: {',
  '        name: err && err.constructor ? err.constructor.name : typeof err,',
  '        message: String(err && err.message !== undefined ? err.message : err),',
  '      },',
  '    };',
  '  }',
  '});',
  'writeFileSync(outPath, JSON.stringify(results));',
].join('\n');

const ESM_JOB_SOURCE = [
  "import * as plist from 'plist';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "import { createHash } from 'node:crypto';",
  JOB_LOGIC,
  '',
].join('\n');

const CJS_JOB_SOURCE = [
  "const plist = require('plist');",
  "const { readFileSync, writeFileSync } = require('node:fs');",
  "const { createHash } = require('node:crypto');",
  JOB_LOGIC,
  '',
].join('\n');

const TYPES_CONSUMER_SOURCE = [
  "import { parse, parseOpenStep, parseBinary, build, buildBinary } from 'plist';",
  "import type { PlistValue } from 'plist';",
  '',
  'const value: PlistValue = {',
  "  text: 'entity & <check>',",
  '  when: new Date(0),',
  '  blob: new Uint8Array([1, 2, 3]),',
  "  nested: [{ uid: { UID: 7 } as unknown as PlistValue }, ['a', 1, true]],",
  '};',
  'const xml: string = build(value);',
  'const fromXml: PlistValue = parse(xml);',
  'const binary: Uint8Array = buildBinary(value);',
  'const fromBinary: PlistValue = parseBinary(binary);',
  "const fromOpenStep: PlistValue = parseOpenStep('{ a = 1; }');",
  'void fromXml;',
  'void fromBinary;',
  'void fromOpenStep;',
  '',
].join('\n');

/* ------------------------------------------------------------------ */
/* 共享状态：beforeAll 中构建、两次 pack、解包、准备 consumer           */
/* ------------------------------------------------------------------ */

interface Job {
  id: string;
  action: 'buildXml' | 'buildBinary' | 'parseXmlFile' | 'parseBinaryFile' | 'parseAutoFile';
  input?: Canon;
  inputFile?: string;
  outFile?: string;
}

interface JobResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { name: string; message: string };
}

interface PackedContext {
  workDir: string;
  pkgDir: string;
  consumerDir: string;
  artifactDir: string;
  manifestA: Map<string, string>;
  manifestB: Map<string, string>;
  gitStatusBefore: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  esm: any;
}

const ctx = {} as PackedContext;

function runJobs(entry: 'esm' | 'cjs', jobs: Job[], tag: string): JobResult[] {
  const jobsPath = join(ctx.workDir, `jobs-${tag}-${entry}.json`);
  const outPath = join(ctx.workDir, `results-${tag}-${entry}.json`);
  writeFileSync(jobsPath, JSON.stringify(jobs));
  execFileSync(
    process.execPath,
    [join(ctx.consumerDir, entry === 'esm' ? 'job.mjs' : 'job.cjs'), jobsPath, outPath],
    { cwd: ctx.consumerDir, stdio: 'pipe' },
  );
  return JSON.parse(readFileSync(outPath, 'utf8')) as JobResult[];
}

function indexById(results: JobResult[]): Map<string, JobResult> {
  return new Map(results.map((result) => [result.id, result]));
}

function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function npmPack(destination: string): string {
  const output = execFileSync(
    'npm',
    ['pack', '--pack-destination', destination, '--ignore-scripts'],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, npm_config_provenance: 'false' } },
  );
  const lines = output.trim().split('\n');
  return join(destination, lines[lines.length - 1].trim());
}

beforeAll(() => {
  ctx.workDir = join(
    tmpdir(),
    `plist-pack-gate-${process.pid}-${Date.now().toString(36)}`,
  );
  ctx.pkgDir = join(ctx.workDir, 'pkg');
  ctx.consumerDir = join(ctx.workDir, 'consumer');
  ctx.artifactDir = join(ctx.workDir, 'artifacts');
  mkdirSync(ctx.pkgDir, { recursive: true });
  mkdirSync(ctx.consumerDir, { recursive: true });
  mkdirSync(ctx.artifactDir, { recursive: true });

  // 1. 通过仓库正式构建入口产出 dist
  execFileSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc')], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  // 2. 连续两次 pack，得到两份 tarball
  const packDirA = join(ctx.workDir, 'pack-a');
  const packDirB = join(ctx.workDir, 'pack-b');
  mkdirSync(packDirA, { recursive: true });
  mkdirSync(packDirB, { recursive: true });
  const tarballA = npmPack(packDirA);
  const tarballB = npmPack(packDirB);
  ctx.manifestA = manifestOf(readTarball(tarballA));
  ctx.manifestB = manifestOf(readTarball(tarballB));

  // 3. 解包第一份 tarball —— 后续所有断言只针对解包产物，不触碰源码目录
  extractTarball(readTarball(tarballA), ctx.pkgDir);

  // 4. 为解包产物链接生产依赖（离线，指向仓库已安装依赖）
  mkdirSync(join(ctx.pkgDir, 'node_modules'), { recursive: true });
  symlinkSync(
    join(repoRoot, 'node_modules/@xmldom'),
    join(ctx.pkgDir, 'node_modules/@xmldom'),
    'dir',
  );
  symlinkSync(
    join(repoRoot, 'node_modules/xmlbuilder'),
    join(ctx.pkgDir, 'node_modules/xmlbuilder'),
    'dir',
  );

  // 5. 准备 consumer：plist 指向解包产物，分别提供 ESM / CJS / 类型入口脚本
  mkdirSync(join(ctx.consumerDir, 'node_modules'), { recursive: true });
  symlinkSync(ctx.pkgDir, join(ctx.consumerDir, 'node_modules/plist'), 'dir');
  writeFileSync(join(ctx.consumerDir, 'job.mjs'), ESM_JOB_SOURCE);
  writeFileSync(join(ctx.consumerDir, 'job.cjs'), CJS_JOB_SOURCE);
  writeFileSync(join(ctx.consumerDir, 'types-consumer.ts'), TYPES_CONSUMER_SOURCE);

  // 6. 在本测试进程内直接加载 tarball 的 ESM 入口（共享模块实例，用于状态隔离断言）
  return import(pathToFileURL(join(ctx.pkgDir, 'dist/index.js')).href).then((mod) => {
    ctx.esm = mod;
    ctx.gitStatusBefore = gitStatus();
  });
}, 180_000);

afterAll(() => {
  rmSync(ctx.workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 跨入口往返阶段：ESM/CJS 分别构建，交叉解析                           */
/* ------------------------------------------------------------------ */

interface PhaseArtifacts {
  xmlEsm?: string;
  xmlCjs?: string;
  binEsm: string;
  binCjs: string;
}

interface PhaseParsed {
  esmFromCjsXml?: unknown;
  cjsFromEsmXml?: unknown;
  esmFromCjsBin: unknown;
  cjsFromEsmBin: unknown;
  autoBin: unknown;
}

interface PhaseResults {
  artifacts: Map<string, PhaseArtifacts>;
  parsed: Map<string, PhaseParsed>;
}

function artifactPath(fx: Fixture, tag: string, entry: 'esm' | 'cjs', ext: 'xml' | 'bplist'): string {
  return join(ctx.artifactDir, `${fx.id}.${tag}.${entry}.${ext}`);
}

function requireOk(result: JobResult | undefined, label: string): asserts result is JobResult & { ok: true } {
  expect(
    result?.ok,
    `${label} 失败: ${JSON.stringify(result?.error ?? 'missing result')}`,
  ).toBe(true);
}

function runRoundTripPhase(tag: string): PhaseResults {
  const buildJobs: Job[] = [];
  for (const fx of fixtures) {
    if (fx.xmlSafe) {
      for (const entry of ['esm', 'cjs'] as const) {
        buildJobs.push({
          id: `${fx.id}:xml:${entry}`,
          action: 'buildXml',
          input: enc(fx.value),
          outFile: artifactPath(fx, tag, entry, 'xml'),
        });
      }
    }
    for (const entry of ['esm', 'cjs'] as const) {
      buildJobs.push({
        id: `${fx.id}:bin:${entry}`,
        action: 'buildBinary',
        input: enc(fx.value),
        outFile: artifactPath(fx, tag, entry, 'bplist'),
      });
    }
  }
  const builtEsm = indexById(runJobs('esm', buildJobs.filter((j) => j.id.endsWith(':esm')), `${tag}-build`));
  const builtCjs = indexById(runJobs('cjs', buildJobs.filter((j) => j.id.endsWith(':cjs')), `${tag}-build`));

  const artifacts = new Map<string, PhaseArtifacts>();
  for (const fx of fixtures) {
    const entry: PhaseArtifacts = { binEsm: '', binCjs: '' };
    if (fx.xmlSafe) {
      const esmXml = builtEsm.get(`${fx.id}:xml:esm`);
      const cjsXml = builtCjs.get(`${fx.id}:xml:cjs`);
      requireOk(esmXml, `ESM 入口构建 XML [${fx.id}]`);
      requireOk(cjsXml, `CJS 入口构建 XML [${fx.id}]`);
      entry.xmlEsm = (esmXml.result as { sha256: string }).sha256;
      entry.xmlCjs = (cjsXml.result as { sha256: string }).sha256;
    }
    const esmBin = builtEsm.get(`${fx.id}:bin:esm`);
    const cjsBin = builtCjs.get(`${fx.id}:bin:cjs`);
    requireOk(esmBin, `ESM 入口构建 binary [${fx.id}]`);
    requireOk(cjsBin, `CJS 入口构建 binary [${fx.id}]`);
    entry.binEsm = (esmBin.result as { sha256: string }).sha256;
    entry.binCjs = (cjsBin.result as { sha256: string }).sha256;
    artifacts.set(fx.id, entry);
  }

  // 交叉解析：ESM 入口读 CJS 产物，CJS 入口读 ESM 产物
  const parseJobsEsm: Job[] = [];
  const parseJobsCjs: Job[] = [];
  for (const fx of fixtures) {
    if (fx.xmlSafe) {
      parseJobsEsm.push({
        id: `${fx.id}:xml`,
        action: 'parseXmlFile',
        inputFile: artifactPath(fx, tag, 'cjs', 'xml'),
      });
      parseJobsCjs.push({
        id: `${fx.id}:xml`,
        action: 'parseXmlFile',
        inputFile: artifactPath(fx, tag, 'esm', 'xml'),
      });
    }
    parseJobsEsm.push({
      id: `${fx.id}:bin`,
      action: 'parseBinaryFile',
      inputFile: artifactPath(fx, tag, 'cjs', 'bplist'),
    });
    parseJobsCjs.push({
      id: `${fx.id}:bin`,
      action: 'parseBinaryFile',
      inputFile: artifactPath(fx, tag, 'esm', 'bplist'),
    });
    parseJobsCjs.push({
      id: `${fx.id}:auto`,
      action: 'parseAutoFile',
      inputFile: artifactPath(fx, tag, 'esm', 'bplist'),
    });
  }
  const parsedEsm = indexById(runJobs('esm', parseJobsEsm, `${tag}-parse`));
  const parsedCjs = indexById(runJobs('cjs', parseJobsCjs, `${tag}-parse`));

  const parsed = new Map<string, PhaseParsed>();
  for (const fx of fixtures) {
    const entry: PhaseParsed = {
      esmFromCjsBin: undefined,
      cjsFromEsmBin: undefined,
      autoBin: undefined,
    };
    if (fx.xmlSafe) {
      const esmXml = parsedEsm.get(`${fx.id}:xml`);
      const cjsXml = parsedCjs.get(`${fx.id}:xml`);
      requireOk(esmXml, `ESM 入口解析 XML [${fx.id}]`);
      requireOk(cjsXml, `CJS 入口解析 XML [${fx.id}]`);
      entry.esmFromCjsXml = esmXml.result;
      entry.cjsFromEsmXml = cjsXml.result;
    }
    const esmBin = parsedEsm.get(`${fx.id}:bin`);
    const cjsBin = parsedCjs.get(`${fx.id}:bin`);
    const autoBin = parsedCjs.get(`${fx.id}:auto`);
    requireOk(esmBin, `ESM 入口解析 binary [${fx.id}]`);
    requireOk(cjsBin, `CJS 入口解析 binary [${fx.id}]`);
    requireOk(autoBin, `parse() 自动识别 binary [${fx.id}]`);
    entry.esmFromCjsBin = esmBin.result;
    entry.cjsFromEsmBin = cjsBin.result;
    entry.autoBin = autoBin.result;
    parsed.set(fx.id, entry);
  }

  return { artifacts, parsed };
}

function phaseToJson(phase: PhaseResults): string {
  return JSON.stringify({
    artifacts: [...phase.artifacts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    parsed: [...phase.parsed.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  });
}

function inProcessRoundtrip(fx: Fixture): string {
  const binBack = ctx.esm.parseBinary(ctx.esm.buildBinary(fx.value));
  const xmlBack = fx.xmlSafe ? ctx.esm.parse(ctx.esm.build(fx.value)) : null;
  return JSON.stringify({
    bin: semantic(enc(binBack)),
    xml: fx.xmlSafe ? semantic(enc(xmlBack)) : null,
  });
}

/* ------------------------------------------------------------------ */
/* 测试用例                                                             */
/* ------------------------------------------------------------------ */

describe('plist.js 发布包跨入口往返与产物一致性门禁', () => {
  let baselinePhase: PhaseResults;

  it('两次 npm pack 的文件清单与逐文件内容哈希一致', () => {
    const namesA = [...ctx.manifestA.keys()].sort();
    const namesB = [...ctx.manifestB.keys()].sort();
    expect(namesA.length, 'tarball 为空').toBeGreaterThan(0);
    expect(namesA).toContain('package/dist/index.js');
    expect(namesB, '两次 pack 的文件清单不一致').toEqual(namesA);
    for (const name of namesA) {
      expect(ctx.manifestB.get(name), `tarball 内容不一致: ${name}`).toBe(
        ctx.manifestA.get(name),
      );
    }
  });

  it('exports / main / types 声明的每个路径都存在于 tarball', () => {
    const pkgJson = JSON.parse(readFileSync(join(ctx.pkgDir, 'package.json'), 'utf8'));
    const declared = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        declared.add(node);
        return;
      }
      if (node !== null && typeof node === 'object') {
        Object.values(node).forEach(walk);
      }
    };
    walk(pkgJson.exports);
    if (typeof pkgJson.main === 'string') declared.add(pkgJson.main);
    if (typeof pkgJson.types === 'string') declared.add(pkgJson.types);
    expect(declared.size, 'package.json 未声明任何入口路径').toBeGreaterThan(0);
    for (const rel of declared) {
      expect(
        existsSync(join(ctx.pkgDir, rel)),
        `exports 声明的路径在 tarball 中不存在: ${rel}`,
      ).toBe(true);
    }
  });

  it('dist 每个 JS 产物都携带 source map、类型声明与声明 map', () => {
    const jsFiles = [...ctx.manifestA.keys()]
      .filter((name) => name.startsWith('package/dist/') && name.endsWith('.js'))
      .map((name) => name.slice('package/'.length));
    expect(jsFiles.length, 'tarball 中没有 dist JS 产物').toBeGreaterThan(0);
    for (const js of jsFiles) {
      const base = js.replace(/\.js$/, '');
      for (const sibling of [`${js}.map`, `${base}.d.ts`, `${base}.d.ts.map`]) {
        expect(
          ctx.manifestA.has(`package/${sibling}`),
          `tarball 缺少产物: ${sibling}`,
        ).toBe(true);
      }
      const map = JSON.parse(readFileSync(join(ctx.pkgDir, `${js}.map`), 'utf8'));
      expect(
        Array.isArray(map.sources) && map.sources.length > 0,
        `${js}.map 缺少 sources`,
      ).toBe(true);
    }
  });

  it(
    '类型入口可被仓库自带 tsc 以严格模式解析',
    () => {
      let output = '';
      let code = 0;
      try {
        execFileSync(
          process.execPath,
          [
            join(repoRoot, 'node_modules/typescript/bin/tsc'),
            '--noEmit',
            '--strict',
            '--skipLibCheck',
            '--target',
            'es2022',
            '--module',
            'nodenext',
            'types-consumer.ts',
          ],
          { cwd: ctx.consumerDir, encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (err) {
        const failure = err as { status?: number; stdout?: unknown; stderr?: unknown };
        code = failure.status ?? 1;
        output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
      }
      expect(code, `类型入口解析失败:\n${output}`).toBe(0);
    },
    60_000,
  );

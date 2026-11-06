// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
/**
 * Release package (design 10):
 *   1. Bundle into a single JS file (afb.mjs) with esbuild;
 *   2. Download the official Node.js 24 linux-arm64 binary and verify it with the official SHASUMS256.txt and its GPG signature;
 *   3. Generate SHA256SUMS inside the package, build the tarball, and generate the sidecar `.tar.gz.sha256` and LATEST;
 *      the output goes to dist/releases/<version>/ and dist/releases/LATEST (the source directory of BucketDeployment is dist/releases);
 *   4. `--upload [--bucket <bucket>]`: upload the new version and update releases/LATEST last.
 *
 * Usage: npm run release [-- --version 0.1.1] [-- --upload --bucket <bucket>]
 * Environment variables: AFB_NODE_VERSION (such as v24.11.1; defaults to the latest v24), AFB_NODE_KEYRING (GPG keyring path)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CACHE = join(DIST, 'cache');
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const NODE_DIST = 'https://nodejs.org/dist';
const NODE_KEYRING_URL = 'https://github.com/nodejs/release-keys/raw/HEAD/gpg/pubring.kbx';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function download(url: string, dest: string): Promise<Buffer> {
  if (existsSync(dest)) return readFileSync(dest);
  console.log(`下载 ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 ${r.status}: ${url}`);
  const b = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, b);
  return b;
}

async function latestNode24(): Promise<string> {
  if (process.env.AFB_NODE_VERSION) return process.env.AFB_NODE_VERSION;
  const r = await fetch(`${NODE_DIST}/index.json`);
  const list = (await r.json()) as { version: string; lts: string | false }[];
  const v = list.find((x) => x.version.startsWith('v24.'));
  if (!v) throw new Error('找不到 Node.js 24 版本');
  return v.version;
}

/** Download and verify the Node binary (GPG signature of SHASUMS256.txt + file sha256) */
async function nodeBinary(nodeVersion: string): Promise<string> {
  const dir = join(CACHE, nodeVersion);
  const name = `node-${nodeVersion}-linux-arm64.tar.xz`;
  const sums = await download(`${NODE_DIST}/${nodeVersion}/SHASUMS256.txt`, join(dir, 'SHASUMS256.txt'));
  await download(`${NODE_DIST}/${nodeVersion}/SHASUMS256.txt.sig`, join(dir, 'SHASUMS256.txt.sig'));
  const keyring = process.env.AFB_NODE_KEYRING ?? join(CACHE, 'nodejs-release-keys.kbx');
  if (!process.env.AFB_NODE_KEYRING) await download(NODE_KEYRING_URL, keyring);
  try {
    execFileSync('gpgv', ['--keyring', keyring, join(dir, 'SHASUMS256.txt.sig'), join(dir, 'SHASUMS256.txt')], { stdio: 'pipe' });
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer };
    if (err.code === 'ENOENT') throw new Error('需要 gpgv 校验 Node.js 发布签名（macOS: brew install gnupg）', { cause: e });
    throw new Error(`SHASUMS256.txt 签名校验失败：${err.stderr?.toString() ?? ''}`, { cause: e });
  }
  console.log('✅ SHASUMS256.txt 签名校验通过');
  const expected = sums
    .toString()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((p) => p[1] === name)?.[0];
  if (!expected) throw new Error(`SHASUMS256.txt 里没有 ${name}`);
  const tarball = await download(`${NODE_DIST}/${nodeVersion}/${name}`, join(dir, name));
  if (sha256(tarball) !== expected) {
    rmSync(join(dir, name));
    throw new Error(`${name} sha256 不一致`);
  }
  console.log(`✅ ${name} 校验通过`);
  const bin = join(dir, 'node');
  if (!existsSync(bin)) {
    execFileSync('tar', ['-xJf', join(dir, name), '-C', dir, '--strip-components=2', `node-${nodeVersion}-linux-arm64/bin/node`]);
  }
  if (!existsSync(join(dir, 'LICENSE'))) {
    execFileSync('tar', ['-xJf', join(dir, name), '-C', dir, '--strip-components=1', `node-${nodeVersion}-linux-arm64/LICENSE`]);
  }
  return bin;
}

/** Find the npm packages bundled in from esbuild's input files and collect their LICENSE / NOTICE files */
function collectNpmLicenses(inputs: string[]): string[] {
  const pkgDirs = new Set<string>();
  for (const f of inputs) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(f);
    if (m) pkgDirs.add(join(ROOT, m[1]!));
  }
  const out: string[] = [];
  const missing: string[] = [];
  for (const dir of [...pkgDirs].sort()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown };
    const files = readdirSync(dir).filter((n) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(n)).sort();
    const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'UNKNOWN');
    out.push(`\n${'='.repeat(78)}\n${pkg.name}@${pkg.version}（${license}）\n${'='.repeat(78)}\n`);
    if (!files.length) {
      missing.push(pkg.name);
      out.push(`（包内没有 LICENSE 文件，许可证声明为 ${license}）\n`);
    }
    for (const n of files) out.push(readFileSync(join(dir, n), 'utf8'));
  }
  console.log(`✅ 收集了 ${pkgDirs.size} 个 npm 依赖的许可证${missing.length ? `（${missing.length} 个包没有 LICENSE 文件：${missing.join(', ')}）` : ''}`);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const s = statSync(p);
    return s.isDirectory() ? walk(p) : [p];
  });
}

function isBsdTar(): boolean {
  return execFileSync('tar', ['--version']).toString().includes('bsdtar');
}

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const version = arg('version') ?? pkg.version;
  if (!VERSION_RE.test(version)) throw new Error(`版本号格式不对：${version}`);

  const outDir = join(DIST, 'releases', version);
  const stage = join(DIST, 'stage', version);
  // The release package file name matches the service name; the host fetch script downloads by this name
  const tarName = `agentcore-feishu-bot-${version}.tar.gz`;

  if (!(has('upload') && existsSync(join(outDir, tarName)))) {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    const built = await build({
      metafile: true,
      entryPoints: [join(ROOT, 'src/main.ts')],
      outfile: join(stage, 'afb.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      minify: false,
      sourcemap: false,
      legalComments: 'none',
      define: { 'process.env.AFB_VERSION': JSON.stringify(version) },
      // Some dependencies are CJS modules (require / __dirname)
      banner: {
        js: [
          "import { createRequire as __afbCreateRequire } from 'node:module';",
          "import { fileURLToPath as __afbFileURLToPath } from 'node:url';",
          "import { dirname as __afbDirname } from 'node:path';",
          'const require = __afbCreateRequire(import.meta.url);',
          'const __filename = __afbFileURLToPath(import.meta.url);',
          'const __dirname = __afbDirname(__filename);',
        ].join(' '),
      },
      logLevel: 'warning',
    });
    console.log('✅ 已打包 afb.mjs');
    const npmLicenses = collectNpmLicenses(Object.keys(built.metafile!.inputs));

    const nodeVersion = await latestNode24();
    const node = await nodeBinary(nodeVersion);
    cpSync(node, join(stage, 'node'));
    // Third-party licenses: the npm dependencies bundled into afb.mjs + the Node.js binary
    writeFileSync(
      join(stage, 'THIRD_PARTY_LICENSES.txt'),
      [
        `本发布包包含以下第三方软件。\n\n${'='.repeat(78)}\nNode.js ${nodeVersion}（linux-arm64 二进制，文件 node）\n${'='.repeat(78)}\n`,
        readFileSync(join(CACHE, nodeVersion, 'LICENSE'), 'utf8'),
        ...npmLicenses,
      ].join('\n'),
    );
    chmodSync(join(stage, 'node'), 0o755);
    cpSync(join(ROOT, 'host'), join(stage, 'host'), { recursive: true });
    writeFileSync(join(stage, 'VERSION'), version + '\n');

    const files = walk(stage).map((p) => relative(stage, p)).sort();
    writeFileSync(join(stage, 'SHA256SUMS'), files.map((f) => `${sha256(readFileSync(join(stage, f)))}  ${f}`).join('\n') + '\n');

    mkdirSync(outDir, { recursive: true });
    // bsdtar on macOS adds extended attributes (com.apple.provenance and so on) by default, and GNU tar on the host warns about them, so none are put into the package
    const owner = isBsdTar()
      ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root', '--no-xattrs', '--no-mac-metadata', '--no-acls', '--no-fflags']
      : ['--owner=0', '--group=0', '--numeric-owner', '--no-xattrs', '--no-acls'];
    execFileSync('tar', ['-czf', join(outDir, tarName), ...owner, '-C', stage, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const digest = sha256(readFileSync(join(outDir, tarName)));
    writeFileSync(join(outDir, `${tarName}.sha256`), `${digest}  ${tarName}\n`);
    writeFileSync(join(DIST, 'releases', 'LATEST'), version + '\n');
    console.log(`✅ 发布产物：dist/releases/${version}/${tarName}（sha256 ${digest}）`);
  }

  if (has('upload')) {
    const bucket = arg('bucket') ?? process.env.AFB_RELEASE_BUCKET;
    if (!bucket) throw new Error('--upload 需要 --bucket <发布桶>（cdk 输出 ReleaseBucket）或 AFB_RELEASE_BUCKET');
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({});
    const put = async (key: string, body: Buffer, contentType: string) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      console.log(`已上传 s3://${bucket}/${key}`);
    };
    await put(`releases/${version}/${tarName}`, readFileSync(join(outDir, tarName)), 'application/gzip');
    await put(`releases/${version}/${tarName}.sha256`, readFileSync(join(outDir, `${tarName}.sha256`)), 'text/plain');
    await put('releases/LATEST', Buffer.from(version + '\n'), 'text/plain'); // Update LATEST last
    console.log(`✅ 已发布 ${version}。到主机上运行 agentcore-chat-bridge update`);
  }
}

main().catch((e: unknown) => {
  console.error(`release 失败：${(e as Error).message}`);
  process.exit(1);
});

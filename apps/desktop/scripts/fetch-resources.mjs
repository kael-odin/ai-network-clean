// 下载运行所需的内核与地理数据库(不打进仓库:体积大,而且各有各的许可证)
// 用法: node apps/desktop/scripts/fetch-resources.mjs [--force] [--only=文件名]
//   默认装到 apps/desktop/resources/,可用 AIN_RES_DIR 指定别处
//   已有文件默认跳过,加 --force 重新下载
//   GitHub 下载慢是常态;也可以自己下好,把文件放进目标目录
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readdir, rename, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.AIN_RES_DIR || join(here, '..', 'resources');
const force = process.argv.includes('--force');
const only = (process.argv.find((x) => x.startsWith('--only=')) || '').slice('--only='.length) || null;

const MIHOMO_VERSION = 'v1.19.32';
const MIHOMO_ZIP = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-windows-amd64-${MIHOMO_VERSION}.zip`;
const GEO_BASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest';

const FILES = [
  { name: 'mihomo.exe', kind: 'zip', url: MIHOMO_ZIP, min: 20 * 1024 * 1024 },
  { name: 'geoip.dat', kind: 'raw', url: `${GEO_BASE}/geoip.dat`, min: 1024 * 1024 },
  { name: 'geosite.dat', kind: 'raw', url: `${GEO_BASE}/geosite.dat`, min: 512 * 1024 },
  { name: 'Country.mmdb', kind: 'raw', url: `${GEO_BASE}/country.mmdb`, min: 512 * 1024 },
];

const sizeOf = async (p) => {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
};
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

async function download(url, dest, timeoutMs = 600_000) {
  process.stdout.write(`  下载 ${url}\n`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  process.stdout.write(`  大小 ${total ? mb(total) : '未知'}\n`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, dest);
}

async function unzip(zip, dest) {
  await new Promise((ok, bad) =>
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`],
      { windowsHide: true, timeout: 180_000 },
      (e, _so, se) => (e ? bad(new Error(String(se || e.message).trim())) : ok()),
    ),
  );
  const stack = [dest];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.toLowerCase() === 'mihomo.exe') return p;
    }
  }
  throw new Error('压缩包里没找到 mihomo.exe');
}

await mkdir(outDir, { recursive: true });
console.log(`目标目录: ${outDir}`);

let failed = 0;
let done = 0;
for (const f of FILES) {
  if (only && f.name.toLowerCase() !== only.toLowerCase()) continue;
  const dest = join(outDir, f.name);
  const size = await sizeOf(dest);
  if (size && !force) {
    console.log(`✓ ${f.name} 已存在(${mb(size)}),跳过`);
    done++;
    continue;
  }
  try {
    if (f.kind === 'zip') {
      const tmp = await mkdtemp(join(tmpdir(), 'ain-kernel-'));
      const zip = join(tmp, 'kernel.zip');
      await download(f.url, zip);
      const exe = await unzip(zip, join(tmp, 'x'));
      await copyFile(exe, dest);
      await rm(tmp, { recursive: true, force: true });
    } else {
      await download(f.url, dest);
    }
    const got = await sizeOf(dest);
    if (got < f.min) throw new Error(`文件太小(${got} 字节),可能下载被拦截`);
    console.log(`✓ ${f.name} 完成(${mb(got)})`);
    done++;
  } catch (e) {
    failed++;
    console.error(`✗ ${f.name}: ${e.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} 个文件没下成。可以手动下载放到 ${outDir}`);
  process.exit(1);
}
if (!done) {
  console.error(`没有匹配的文件:${only ?? '(空)'}`);
  process.exit(1);
}
console.log('\n内核与地理数据库就绪,可以 npm run build / npm run dist:win 了');

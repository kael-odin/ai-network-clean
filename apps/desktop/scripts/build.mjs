// 打包:主进程 / 预加载(CJS,node)+ 渲染层(浏览器 bundle,React)
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '../..');

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
  absWorkingDir: appRoot,
};

await mkdir(join(appRoot, 'dist/main'), { recursive: true });
await mkdir(join(appRoot, 'dist/preload'), { recursive: true });
await mkdir(join(appRoot, 'dist/renderer/assets'), { recursive: true });

await build({ ...node, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs' });
await build({ ...node, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs' });

await build({
  entryPoints: ['src/renderer/main.tsx'],
  outfile: 'dist/renderer/assets/index.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome140',
  sourcemap: false,
  minify: true,
  charset: 'utf8',   // 中文文案原样输出(esbuild 默认会转义成 U+XXXX)
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'css', '.png': 'dataurl', '.svg': 'dataurl' },
  logLevel: 'info',
  absWorkingDir: appRoot,
});

// 内核配置模板(分流规则、DNS 防泄漏、AI 闸门)
await copyFile(join(repoRoot, 'packages/rules/ai-network-script.js'), join(appRoot, 'dist/main/ai-network-script.js'));

// 渲染层入口页
const css = existsSync(join(appRoot, 'dist/renderer/assets/index.css'));
await writeFile(join(appRoot, 'dist/renderer/index.html'), `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>AI Network Clean</title>
    <link rel="stylesheet" href="./assets/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./assets/index.js"></script>
  </body>
</html>
`);

// 图标(没有就生成)
if (!existsSync(join(appRoot, 'build/icon.png'))) {
  await import('./make-icon.mjs');
}
// 内核的 SHA-256:打包时登记,打包版启动前核对。
// 程序按最高权限运行,安装目录普通权限就能写——登记哈希能让「装好之后被换了一个 exe」在启动时被发现
if (existsSync(join(appRoot, 'resources/mihomo.exe'))) {
  const sha = createHash('sha256').update(await readFile(join(appRoot, 'resources/mihomo.exe'))).digest('hex');
  await writeFile(join(appRoot, 'dist/main/kernel.sha256'), sha + String.fromCharCode(10));
  console.log(`kernel sha256: ${sha.slice(0, 16)}…`);
} else {
  console.warn('⚠ 缺 resources/mihomo.exe:开发时可用 AIN_MIHOMO_BIN 指定内核路径');
}
console.log(`built: dist/main/index.cjs, dist/preload/index.cjs, dist/renderer (css=${css})`);

// 用 CDP 直接截图页面(不依赖窗口层级/焦点),输出 PNG
// 用法: node tools/shot.mjs <cdpPort> <outfile> [page|tray]
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 9333);
const out = process.argv[3] ?? 'shot.png';
const which = process.argv[4] ?? 'page';

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html') && (which === 'tray' ? String(t.url).includes('#tray') : !String(t.url).includes('#tray')));
if (!page) { console.error('找不到页面'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

// 等一帧,避免截到切换动画中间
await new Promise((r) => setTimeout(r, 600));
const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
const data = res.result?.data;
if (!data) { console.error('截图失败', JSON.stringify(res).slice(0, 300)); process.exit(1); }
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved', out, Math.round(Buffer.from(data, 'base64').length / 1024) + 'KB');
ws.close();

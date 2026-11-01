// 连上后保持 75 秒(方便截图),再断开
const port = Number(process.argv[2] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;

await ev('(async () => { await window.ain.connect(); return true })()');
let s;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  s = await ev('(async () => await window.ain.state())()');
  if (s.conn.status === 'connected' && s.aiCheck && s.aiCheck.state !== 'waiting') break;
}
console.log('connected:', s.conn.status, 'gate:', s.aiCheck?.state, 'exit:', s.conn.exitIp);
// 顺手跑一次分流测试和诊断,让界面上有数据
await ev('(async () => { await window.ain.splitTest(); await window.ain.diagnose(); return true })()');
await sleep(3000);
console.log('holding 75s…');
await sleep(75_000);
await ev('(async () => { await window.ain.disconnect(); return true })()');
console.log('disconnected');
ws.close();

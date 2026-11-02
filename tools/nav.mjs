// 切页面(并可确保已连接),方便截图
const port = Number(process.argv[2] ?? 9333);
const target = process.argv[3] ?? 'home';
const needConnect = process.argv[4] === 'connect';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html') && !String(t.url).includes('#tray'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;

if (needConnect) {
  const st = await ev('(async () => await window.ain.state())()');
  if (st.conn.status !== 'connected') {
    await ev('(async () => { await window.ain.connect(); return true })()');
    for (let i = 0; i < 60; i++) { await sleep(1000); const s = await ev('(async () => await window.ain.state())()'); if (s.conn.status === 'connected' && s.aiCheck && s.aiCheck.state !== 'waiting') break; }
  }
}
await ev(`(async () => { await window.ain.showWindow(${JSON.stringify(target)}); return true })()`);
await sleep(800);
console.log('page →', target);
ws.close();

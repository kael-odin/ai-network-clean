// 逐个节点扫一遍:经该节点向静态代理发「带认证的 GET /」,把供应商的原始 errorMsg 打出来
import net from 'node:net';

const port = Number(process.argv[2] ?? 9333);
const [ph, pp, user, pass] = process.argv.slice(3);
const b64 = Buffer.from(`${user}:${pass}`).toString('base64');
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

function probe(mixedPort) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: mixedPort, timeout: 25_000 });
    let buf = '';
    const t = setTimeout(() => { try { s.destroy(); } catch { /* */ } resolve('超时'); }, 25_000);
    s.on('error', (e) => { clearTimeout(t); resolve('错误 ' + e.code); });
    s.once('connect', () => s.write(`CONNECT ${ph}:${pp} HTTP/1.1\r\nHost: ${ph}:${pp}\r\n\r\n`));
    let stage = 0;
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (stage === 0) {
        if (!/\r\n\r\n/.test(buf)) return;
        if (!buf.startsWith('HTTP/1.1 200')) { clearTimeout(t); try { s.destroy(); } catch { /* */ } resolve('第一跳: ' + buf.split('\r\n')[0]); return; }
        buf = '';
        stage = 1;
        s.write(`GET / HTTP/1.1\r\nHost: ${ph}\r\nProxy-Authorization: Basic ${b64}\r\nConnection: close\r\n\r\n`);
        return;
      }
      const m = buf.match(/errorMsg: ?([^\r\n]*)/);
      if (m || buf.length > 400) {
        clearTimeout(t);
        try { s.destroy(); } catch { /* */ }
        resolve(m ? m[1] : buf.split('\r\n')[0]);
      }
    });
    s.on('close', () => { clearTimeout(t); const m = buf.match(/errorMsg: ?([^\r\n]*)/); resolve(m ? m[1] : (buf ? buf.split('\r\n')[0] : '关闭,无响应')); });
  });
}

await ev('(async () => { await window.ain.connect(); return true })()');
let s;
for (let i = 0; i < 90; i++) { await sleep(1000); s = await ev('(async () => await window.ain.state())()'); if (s.conn.status === 'connected') break; }
if (s.conn.status !== 'connected') { console.log('连接失败:', s.conn.error); process.exit(1); }
console.log('已连接,模式:', s.conn.mode, '混合端口:', s.settings.mixedPort);
await ev('(async () => { await window.ain.refreshNodes(); return true })()');
s = await ev('(async () => await window.ain.state())()');
const nodes = s.nodes?.nodes ?? [];
const byRegion = {};
for (const n of nodes) (byRegion[n.region] ??= []).push(n.name);
console.log('地区:', Object.fromEntries(Object.entries(byRegion).map(([k, v]) => [k, v.length])));

const picks = [];
for (const r of ['HK', 'JP', 'US', 'SG', 'TW', 'KR']) {
  const arr = (byRegion[r] ?? []).filter((n) => !/到期|套餐|官网|剩余|流量/.test(n));
  if (arr[0]) picks.push(arr[0]);
  if (arr[1]) picks.push(arr[1]);
}
if (picks.length === 0) picks.push(s.nodes?.selected ?? '');

const results = [];
for (const name of picks.slice(0, 10)) {
  await ev(`(async () => { await window.ain.selectNode(${JSON.stringify(name)}); return true })()`);
  await sleep(3500);
  const cur = await ev('(async () => (await window.ain.state()).conn.node)()');
  const r = await probe(s.settings.mixedPort);
  results.push({ name, exitNode: cur, resp: r });
  console.log(`\n${name}\n   当前节点=${cur}\n   供应商回复: ${r}`);
}
await ev('(async () => { await window.ain.disconnect(); return true })()');
ws.close();

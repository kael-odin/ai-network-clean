// 换地区节点再测静态 IP:验证「供应商是否只允许特定国家的来源」
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

async function probe() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 17897, timeout: 20_000 });
    let buf = '';
    s.on('error', (e) => resolve('hop错误 ' + e.code));
    s.on('timeout', () => resolve('hop超时'));
    s.once('connect', () => s.write(`CONNECT ${ph}:${pp} HTTP/1.1\r\nHost: ${ph}:${pp}\r\n\r\n`));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (/\r\n\r\n/.test(buf) && buf.startsWith('HTTP/1.1 200')) {
        buf = '';
        s.write(`GET / HTTP/1.1\r\nHost: ${ph}\r\nProxy-Authorization: Basic ${b64}\r\nConnection: close\r\n\r\n`);
        s.on('data', (d2) => {
          buf += d2.toString('latin1');
          if (/errorMsg|200 OK/.test(buf)) { try { s.destroy(); } catch { /* */ } resolve(buf.match(/errorMsg:.*/)?.[0] ?? buf.split('\r\n')[0]); }
        });
        setTimeout(() => resolve(buf ? (buf.match(/errorMsg:.*/)?.[0] ?? '(无 errorMsg)') : '(无响应)'), 9000);
      } else if (/\r\n\r\n/.test(buf)) { try { s.destroy(); } catch { /* */ } resolve('第一跳失败: ' + buf.split('\r\n')[0]); }
    });
  });
}

await ev('(async () => { await window.ain.connect(); return true })()');
let s;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  s = await ev('(async () => await window.ain.state())()');
  if (s.conn.status === 'connected') break;
}
console.log('连接:', s.conn.status, '当前节点:', s.conn.node);
await ev('(async () => { await window.ain.refreshNodes(); return true })()');
 s = await ev('(async () => await window.ain.state())()');
const nodes = s.nodes?.nodes ?? [];
const byRegion = {};
for (const n of nodes) (byRegion[n.region] ??= []).push(n.name);
console.log('地区分布:', Object.fromEntries(Object.entries(byRegion).map(([k, v]) => [k, v.length])));

for (const region of ['US', 'JP', 'HK', 'SG']) {
  const cand = (byRegion[region] ?? []).find((n) => !/到期|套餐|官网|剩余/.test(n));
  if (!cand) { console.log(`\n[${region}] 没有候选节点`); continue; }
  await ev(`(async () => { await window.ain.selectNode(${JSON.stringify(cand)}); return true })()`);
  await sleep(4000);
  const cur = await ev('(async () => (await window.ain.state()).conn.node)()');
  const r = await probe();
  console.log(`\n[${region}] ${cand} → ${r}`);
}
await ev('(async () => { await window.ain.disconnect(); return true })()');
ws.close();

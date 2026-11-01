// 端到端复验:连接 → 分流测试 → 看系统代理 → 断开 → 看系统代理还原
import { execFileSync } from 'node:child_process';

const port = Number(process.argv[2] ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const regProxy = () => {
  const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8' });
  const en = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(out)?.[1] ?? '?';
  const sv = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? '(空)';
  return `${en} ${sv}`;
};

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails.exception?.description));
  return res.result?.result?.value;
};
const st = () => ev('(async () => await window.ain.state())()');

console.log('系统代理(连接前):', regProxy());
await ev('(async () => { await window.ain.connect(); return true })()');
let s;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  s = await st();
  if (s.conn.status === 'connected') break;
}
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  s = await st();
  if (s.aiCheck && s.aiCheck.state !== 'waiting') break;
}
console.log('状态:', s.conn.status, '| 模式:', s.conn.mode, '| 线路:', s.conn.lineUp, '| 出口:', s.conn.exitIp);
console.log('闸门:', s.aiCheck?.state, s.aiCheck?.reason ?? '', '| 站点:', JSON.stringify(s.aiCheck?.sites ?? []));
console.log('系统代理(连接中):', regProxy());

const rows = await ev('(async () => await window.ain.splitTest())()');
console.log('\n分流测试:');
for (const r of rows ?? []) console.log(`  ${String(r.lane).padEnd(8)}${String(r.name).padEnd(9)}${r.ok ? 'ok ' : 'ERR'}  实际=${String(r.route ?? '?').padEnd(8)}应=${String(r.expect).padEnd(7)}ip=${r.ip ?? '-'}`);

const conns = await ev('(async () => (await window.ain.connections()).active.map(c => c.host + " -> " + c.route).slice(0, 12))()');
console.log('\n内核连接表(前 12):', JSON.stringify(conns));

await ev('(async () => { await window.ain.disconnect(); return true })()');
await sleep(2500);
console.log('\n系统代理(断开后):', regProxy());
const s2 = await st();
console.log('断开后状态:', s2.conn.status, '| 保护:', s2.protect === null ? '已清空' : '还在');
ws.close();

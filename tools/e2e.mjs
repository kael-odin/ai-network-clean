// 通过 CDP 驱动运行中的客户端:调用 window.ain.*,读状态,做端到端验证
// 用法:node tools/e2e.mjs <cdp-port>
const port = Number(process.argv[2] ?? 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('没找到页面');
}

const page = await findPage();
console.log('page:', page.title, page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

async function ev(expression, awaitPromise = true) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (res.result?.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails));
  return res.result?.result?.value;
}

const brief = (s) => ({
  step: s.step,
  conn: { status: s.conn.status, mode: s.conn.mode, lineUp: s.conn.lineUp, exitIp: s.conn.exitIp, expected: s.conn.expectedIp, node: s.conn.node, error: s.conn.error, warning: s.conn.warning },
  aiCheck: s.aiCheck && { state: s.aiCheck.state, reason: s.aiCheck.reason, sites: s.aiCheck.sites, warn: s.aiCheck.warn },
  protect: s.protect && Object.fromEntries(Object.entries(s.protect).filter(([k]) => k !== 'at').map(([k, v]) => [k, v.state + (v.detail ? ':' + v.detail.slice(0, 60) : '')])),
  claudeCode: s.claudeCode && s.claudeCode.state,
  logTail: s.log.slice(-6).map((e) => `${e.kind}: ${e.text.slice(0, 80)}`),
});

console.log('\n=== 连接前 ===');
console.log(JSON.stringify(brief(await ev('(async () => await window.ain.state())()')), null, 2));

console.log('\n=== 连接 ===');
await ev('(async () => { await window.ain.connect(); return true })()');
let s;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  s = await ev('(async () => await window.ain.state())()');
  if (s.conn.status === 'connected' || s.conn.status === 'failed') break;
  if (i % 5 === 0) console.log(`  … ${s.conn.status} ${s.conn.warning ?? ''}`);
}
console.log(JSON.stringify(brief(s), null, 2));

if (s.conn.status === 'connected') {
  console.log('\n=== 等防护检测 ===');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    s = await ev('(async () => await window.ain.state())()');
    if (s.aiCheck && s.aiCheck.state !== 'waiting') break;
  }
  console.log(JSON.stringify(brief(s), null, 2));

  console.log('\n=== 节点 ===');
  console.log(JSON.stringify(await ev('(async () => await window.ain.state().then(s => s.nodes))()'), null, 2));

  console.log('\n=== 分流测试 ===');
  const rows = await ev('(async () => await window.ain.splitTest())()');
  for (const r of rows ?? []) console.log(`  ${r.lane.padEnd(7)} ${r.name.padEnd(8)} ${r.ok ? 'ok ' : 'ERR'} 实际=${r.route ?? '?'} 应=${r.expect} ip=${r.ip ?? '-'} ${r.node ?? ''}`);

  console.log('\n=== 诊断 ===');
  await ev('(async () => { await window.ain.diagnose(); return true })()');
  await sleep(4000);
  s = await ev('(async () => await window.ain.state())()');
  if (s.diag) {
    console.log(' ', s.diag.summary);
    for (const st of s.diag.steps) console.log(`  [${st.state}] ${st.title}: ${st.detail}`);
    for (const a of s.diag.advice) console.log('  建议:', a);
  }

  console.log('\n=== 断开 ===');
  await ev('(async () => { await window.ain.disconnect(); return true })()');
  await sleep(2000);
  console.log(JSON.stringify(brief(await ev('(async () => await window.ain.state())()')), null, 2));
}

ws.close();
console.log('\nE2E DONE');

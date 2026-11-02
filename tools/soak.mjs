// 长跑观察:定期通过调试端口读一次客户端状态,把指标和系统资源追加到 CSV。
// 不连网、不改任何设置,只是读;客户端必须带 --remote-debugging-port 启动。
//
// 用法(管理员启动客户端后):
//   node tools/soak.mjs 9333 3600 out.csv
//   参数:调试端口 / 采样间隔秒(默认 3600) / 输出文件(默认 soak-<时间>.csv)
// 跑完把 CSV 发出来就行,里面不含账号和订阅(只记 IP 是否变化、状态、次数、内存)
const port = Number(process.argv[2] ?? 9333);
const every = Number(process.argv[3] ?? 3600) * 1000;
const out = process.argv[4] ?? `soak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
const { appendFileSync, existsSync, writeFileSync } = await import('node:fs');

const HEAD = ['time', 'status', 'mode', 'lineUp', 'exitChanged', 'gate', 'aiBlocks', 'leaks', 'dnsReverts', 'autoRecovers', 'reconnected',
  'fullChecks', 'netChanges', 'logMB', 'heapMB', 'handles'];
if (!existsSync(out)) writeFileSync(out, HEAD.join(',') + '\n');

// 调试端口只在本地;任何一次失败都说明客户端退出或端口没开
async function sample() {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html') && !String(t.url).includes('#tray'));
  if (!page) throw new Error('找不到主窗口');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.addEventListener('open', ok); ws.addEventListener('error', bad); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const st = await ev('(async () => await window.ain.state())()');
  const mem = await ev('JSON.stringify(performance.memory ? { used: performance.memory.usedJSHeapSize, handles: 0 } : { used: 0, handles: 0 })');
  ws.close();
  const m = JSON.parse(mem || '{"used":0,"handles":0}');
  const s = st.stats ?? {};
  const ip = st.conn.exitIp ?? '';
  const prev = (globalThis.__prevIp ??= ip);
  const exitChanged = prev && ip && prev !== ip ? 1 : 0;
  globalThis.__prevIp = ip || prev;
  return [
    new Date().toISOString(), st.conn.status, st.conn.mode, String(st.conn.lineUp), exitChanged,
    st.aiCheck?.state ?? '', s.gateBlocks ?? 0, s.leaks ?? 0, s.dnsReverts ?? 0, s.autoRecovers ?? 0, s.reconnected ?? 0,
    s.fullChecks ?? 0, s.netChanges ?? 0, ((s.logBytes ?? 0) / 1048576).toFixed(2),
    (m.used / 1048576).toFixed(1), m.handles,
  ].join(',');
}

const line = await sample();
appendFileSync(out, line + '\n');
console.log(line);
console.log(`已写入 ${out};接下来每 ${every / 60000} 分钟采一次,ctrl-c 结束`);
setInterval(() => {
  sample().then((l) => { appendFileSync(out, l + '\n'); console.log(l); })
    .catch((e) => console.error('采样失败(客户端可能退出了):', e.message));
}, every);

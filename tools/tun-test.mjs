// TUN 模式实测:连上 → 采样(虚拟网卡/DNS/出口/防护/连通性) → 断开 → 核对是否还原
// 设计成独立进程:即使和模型的连接断了,它也会按时断开连接、把网络还回去
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 9336);
const out = process.argv[3] ?? 'tun-test';
const lines = [];
const results = [];
const t0 = Date.now();
const log = (s) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`;
  lines.push(line);
  console.log(line);
};
const flush = () => {
  writeFileSync(`${out}.log`, lines.join('\n') + '\n');
  writeFileSync(`${out}.json`, JSON.stringify({ ok: !results.some((r) => r.ok === false), results, log: lines }, null, 2));
};
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
};

const ps = (cmd) =>
  new Promise((ok, bad) =>
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + cmd],
      { windowsHide: true, timeout: 40_000 },
      (e, so, se) => (e ? bad(new Error(String(se || e.message).trim())) : ok(String(so ?? '').trim())),
    ),
  );

async function cdp() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html') && !String(t.url).includes('#tray'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res);
          ws.addEventListener('error', rej);
          setTimeout(() => rej(new Error('CDP 打开超时')), 8000);
        });
        let id = 0;
        const pending = new Map();
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        });
        const send = (method, params = {}) =>
          new Promise((r) => {
            const i = ++id;
            pending.set(i, r);
            ws.send(JSON.stringify({ id: i, method, params }));
          });
        const ev = async (expr) => {
          const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
          if (r.result?.exceptionDetails) {
            throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '页面里报错');
          }
          return r.result?.result?.value;
        };
        return { ev, close: () => ws.close() };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('等不到应用窗口(CDP 180s)');
}

const state = async (ev) => JSON.parse(await ev(`(async()=>JSON.stringify(await window.ain.state()))()`));
const sampleNet = async () => {
  const adapters = await ps(`(Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object { $_.Name + '|' + $_.InterfaceDescription }) -join '; '`).catch((e) => 'ERR ' + e.message);
  const dns = await ps(`(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses} | ForEach-Object { $_.InterfaceAlias + '|' + ($_.ServerAddresses -join ',') }) -join '; '`).catch((e) => 'ERR ' + e.message);
  const route = await ps(`(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | ForEach-Object { $_.InterfaceAlias + '|' + $_.NextHop + '|' + $_.RouteMetric }) -join '; '`).catch((e) => 'ERR ' + e.message);
  const sysproxy = await ps(`$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; 'ProxyEnable=' + $p.ProxyEnable + ' ProxyServer=' + $p.ProxyServer + ' PAC=' + $p.AutoConfigURL`).catch((e) => 'ERR ' + e.message);
  return { adapters, dns, route, sysproxy };
};
const curlCode = (url) => ps(`& curl.exe -s -o NUL -w "%{http_code}" --max-time 12 '${url}'`).catch(() => 'ERR');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let c = null;
let before = null;
try {
  c = await cdp();
  const { ev } = c;
  before = await sampleNet();
  log('连接前网卡: ' + before.adapters);
  log('连接前 DNS : ' + before.dns);
  log('连接前 路由: ' + before.route);
  log('连接前系统代理: ' + before.sysproxy);
  const s0 = await state(ev);
  check('测试前是断开状态', s0.conn.status === 'disconnected', s0.conn.status + ' · 管理员=' + s0.admin);
  if (!s0.admin) throw new Error('不是管理员权限,开不了 TUN');

  log('把 tun 设为 auto 并连接…');
  await ev(`(async()=>{await window.ain.setSettings({tun:'auto'});await window.ain.connect();return 1})()`);

  let s = null;
  const upTo = Date.now() + 90_000;
  while (Date.now() < upTo) {
    await sleep(2500);
    s = await state(ev);
    if (s.conn.status === 'connected' || s.conn.status === 'failed') break;
    log(`  …${s.conn.status}${s.conn.warning ? ' · ' + s.conn.warning : ''}`);
  }
  if (!s || s.conn.status !== 'connected') {
    check('连接成功', false, s ? `${s.conn.status} ${s.conn.error || ''}` : '拿不到状态');
    throw new Error('连接没有成功,不进入采样');
  }
  check('连接成功', true, `模式 ${s.conn.mode} · 出口 ${s.conn.exitIp}`);
  check('用的是 TUN 模式', s.conn.mode === 'tun', String(s.conn.mode));
  check('出口是静态 IP', String(s.conn.exitIp) === String(s0.settings.line.exitIp), `${s.conn.exitIp} / 期望 ${s0.settings.line.exitIp}`);

  // 防护检测和 AI 站点核对是连接后才跑的,等它出结果(最多 45 秒)
  let prot = s.protect;
  let ai = s.aiCheck;
  const aiReady = (x) => !!x && (x.state === 'blocked' || (x.state === 'done' && (x.sites || []).length > 0));
  const protTo = Date.now() + 60_000;
  while (Date.now() < protTo && (!prot || !aiReady(ai))) {
    await sleep(3000);
    s = await state(ev);
    prot = s.protect;
    ai = s.aiCheck;
    log(`  …等检测:防护${prot ? '有结果' : '还没出'} · AI 核对 ${ai ? ai.state : '还没出'}`);
  }

  // 采样有网的证据(经默认路由,也就是虚拟网卡)
  await sleep(1500);
  const mid = await sampleNet();
  log('连接后网卡: ' + mid.adapters);
  log('连接后 DNS : ' + mid.dns);
  log('连接后 路由: ' + mid.route);
  log('连接后系统代理: ' + mid.sysproxy);
  check('出现了虚拟网卡', /Meta|Mihomo|Clash|TUN|wintun/i.test(mid.adapters), mid.adapters);
  check('物理网卡 DNS 已指向内核', mid.dns.includes('198.18.0.2'), mid.dns);
  check('默认路由切到虚拟网卡', /Meta|Mihomo|Clash|TUN|wintun/i.test(mid.route.split(';')[0] ?? ''), mid.route);
  check('TUN 下没有再改系统代理', /ProxyEnable=0/.test(mid.sysproxy), mid.sysproxy);

  const code204 = await curlCode('https://www.gstatic.com/generate_204');
  check('国外连通(gstatic 204)', code204 === '204', code204);
  const codeBaidu = await curlCode('https://www.baidu.com');
  check('国内连通(baidu 200)', codeBaidu === '200', codeBaidu);
  const dnsClaude = await ps(`(Resolve-DnsName -Name claude.ai -Type A -ErrorAction Stop | Where-Object {$_.IPAddress} | ForEach-Object { $_.IPAddress }) -join ','`).catch((e) => 'ERR ' + e.message);
  check('claude.ai 能解析(且走 fake-ip)', /^198\.18\./.test(dnsClaude), dnsClaude);
  const trace = await ps(`& curl.exe -s --max-time 12 https://www.cloudflare.com/cdn-cgi/trace`).catch(() => '');
  const traceIp = (String(trace).match(/^ip=(.+)$/m) || [])[1] ?? '';
  check('浏览器出口 = 静态 IP(cloudflare trace)', traceIp === String(s0.settings.line.exitIp), traceIp || '读不到');

  if (prot) {
    for (const k of ['ip', 'dns', 'route', 'ipv6', 'webrtc', 'conflict']) {
      const it = prot[k];
      if (it) check(`防护 ${k}`, it.state === 'ok' || it.state === 'unknown', `${it.state} · ${it.detail}`);
    }
    check('防护 DNS 走的是 TUN 那套结论', /DNS/.test(prot.dns?.detail ?? ''), prot.dns?.detail ?? '');
  } else check('防护检测', false, '等了 45 秒还没有结果');
  const sites = (ai?.sites || []);
  check(
    'AI 站点看到的出口',
    ai?.state === 'done' && sites.length > 0 && sites.every((x) => String(x.ip) === String(s0.settings.line.exitIp)),
    `state=${ai?.state ?? '无'} · ` + (sites.length ? sites.map((x) => `${x.name}:${x.ip}`).join(' · ') : '没有核对结果') + (ai?.warn ? ' · ' + ai.warn : ''),
  );

  // 保持一小会儿,再正常断开
  await sleep(5000);
  log('断开…');
  await ev(`(async()=>{await window.ain.disconnect();return 1})()`);
  let down = null;
  const downTo = Date.now() + 45_000;
  while (Date.now() < downTo) {
    await sleep(2000);
    down = await state(ev);
    if (down.conn.status === 'disconnected') break;
  }
  check('断开成功', !!down && down.conn.status === 'disconnected', down?.conn.status ?? '拿不到状态');
  await sleep(2500);
  const after = await sampleNet();
  log('断开后网卡: ' + after.adapters);
  log('断开后 DNS : ' + after.dns);
  log('断开后 路由: ' + after.route);
  log('断开后系统代理: ' + after.sysproxy);
  check('虚拟网卡已消失', !/Meta|Mihomo|Clash|TUN|wintun/i.test(after.adapters), after.adapters);
  check('物理网卡 DNS 已还原', after.dns === before.dns, `前 ${before.dns} → 后 ${after.dns}`);
  check('默认路由已还原', after.route === before.route, `前 ${before.route} → 后 ${after.route}`);
  check('系统代理已还原', after.sysproxy === before.sysproxy, `前 ${before.sysproxy} → 后 ${after.sysproxy}`);
  const codeAfter = await curlCode('https://www.baidu.com');
  check('断开后网络正常', codeAfter === '200', codeAfter);
} catch (e) {
  log('脚本中断: ' + e.message);
  results.push({ name: '执行中断', ok: false, detail: e.message });
} finally {
  // 兜底:无论出什么错,都尝试断开
  try {
    if (c) {
      const s = await state(c.ev).catch(() => null);
      if (s && s.conn.status !== 'disconnected') {
        log('兜底断开…');
        await c.ev(`(async()=>{await window.ain.disconnect();return 1})()`).catch(() => {});
        await sleep(4000);
      }
    }
  } catch {}
  try { c?.close(); } catch {}
  flush();
  const bad = results.filter((r) => r.ok === false);
  log(bad.length ? `结论:${bad.length} 项未通过` : '结论:全部通过');
  process.exit(bad.length ? 1 : 0);
}

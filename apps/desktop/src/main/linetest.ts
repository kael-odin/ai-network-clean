// 静态 IP 自检:先按 SOCKS5 试(大多数静态 ISP 是这个),明确不是 SOCKS5 再按 HTTP 试。
// 重要:供应商的边缘 WAF 会对"不被允许的来源"回一个 HTTP 403 错误页,
// 所以"收到 HTTP 响应"并不等于"它是 HTTP 代理"——以 SOCKS5 握手成不成功为准。
import net from 'node:net';
import type { Line, LineTestResult, LineTestStep } from '../shared/ipc.ts';

const b64 = (s: string) => Buffer.from(`${s}`).toString('base64');

function tcp(host: string, port: number, timeout = 12_000): Promise<net.Socket | null> {
  return new Promise((ok) => {
    const s = net.connect({ host, port, timeout });
    const done = (v: net.Socket | null) => { s.removeAllListeners(); ok(v); };
    s.once('connect', () => done(s));
    s.once('timeout', () => { s.destroy(); done(null); });
    s.once('error', () => { s.destroy(); done(null); });
  });
}

// 到目标代理的通道:直连,或经本机内核 CONNECT 出去
async function open(line: Line, mixedPort?: number): Promise<{ sock: net.Socket | null; error: string }> {
  if (!mixedPort) {
    const s = await tcp(line.server, line.port, 10_000);
    return { sock: s, error: s ? '' : '直连不到' };
  }
  const s = await tcp('127.0.0.1', mixedPort, 25_000);
  if (!s) return { sock: null, error: '连不上本机内核' };
  const head = await new Promise<string>((ok) => {
    let buf = '';
    const t = setTimeout(() => ok(buf), 20_000);
    s.on('data', (d) => { buf += d.toString('latin1'); if (/\r\n\r\n/.test(buf)) { clearTimeout(t); ok(buf); } });
    s.once('close', () => { clearTimeout(t); ok(buf); });
    s.once('error', () => { clearTimeout(t); ok(buf); });
    s.write(`CONNECT ${line.server}:${line.port} HTTP/1.1\r\nHost: ${line.server}:${line.port}\r\n\r\n`);
  });
  if (!/^HTTP\/1\.1 200/i.test(head)) {
    try { s.destroy(); } catch { /* */ }
    return { sock: null, error: head.split('\r\n')[0] || '通道没建起来' };
  }
  return { sock: s, error: '' };
}

function readN(sock: net.Socket, n: number, ms = 8000): Promise<Buffer | null> {
  return new Promise((ok) => {
    let buf = Buffer.alloc(0);
    const finish = (v: Buffer | null) => { clearTimeout(t); sock.removeListener('data', onData); ok(v); };
    const t = setTimeout(() => finish(buf.length ? buf : null), ms);
    const onData = (d: Buffer) => { buf = Buffer.concat([buf, d]); if (buf.length >= n) finish(buf); };
    sock.on('data', onData);
    sock.once('close', () => finish(buf.length ? buf : null));
    sock.once('error', () => finish(buf.length ? buf : null));
  });
}

function readText(sock: net.Socket, payload: string, ms = 10_000): Promise<string> {
  return new Promise((ok) => {
    let out = '';
    const finish = () => { clearTimeout(t); sock.removeAllListeners('data'); ok(out); };
    const t = setTimeout(finish, ms);
    sock.on('data', (d) => { out += d.toString('utf8'); if (out.length > 4000) finish(); });
    sock.once('close', finish);
    sock.once('error', finish);
    try { sock.write(payload); } catch { finish(); }
  });
}

const statusOf = (t: string): number | null => Number(t.match(/^HTTP\/1\.[01] (\d{3})/m)?.[1] ?? NaN) || null;
const errOf = (t: string): string => t.match(/errorMsg: ?([^\r\n]*)/i)?.[1]?.trim() ?? '';

// SOCKS5:问候 → 认证 → CONNECT 三步都过才算通
async function socks5(line: Line, mixedPort?: number): Promise<{ steps: LineTestStep[]; ok: boolean; isSocks5: boolean; raw: string }> {
  const steps: LineTestStep[] = [];
  const o = await open(line, mixedPort);
  if (!o.sock) return { steps: [{ key: 's5', label: 'SOCKS5', ok: false, detail: o.error }], ok: false, isSocks5: false, raw: '' };
  const s = o.sock;
  const auth = line.username || line.password;
  s.write(Buffer.from(auth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  const g = await readN(s, 2, 6000);
  if (!g || g.length < 2) { try { s.destroy(); } catch { /* */ } return { steps: [{ key: 's5', label: 'SOCKS5', ok: null, detail: '问候没有回应(来源可能被丢弃)' }], ok: false, isSocks5: false, raw: '' }; }
  if (g[0] !== 0x05) {
    const txt = g.toString('latin1');
    try { s.destroy(); } catch { /* */ }
    return {
      steps: [{ key: 's5', label: 'SOCKS5', ok: false, detail: /HTTP\/1\.[01]/.test(txt) ? '端口回的是 HTTP 页面(多半是供应商的拒绝页)' : '端口不是 SOCKS5' }],
      ok: false, isSocks5: false, raw: txt.slice(0, 200),
    };
  }
  if (g[1] === 0x02) {
    if (!auth) { try { s.destroy(); } catch { /* */ } return { steps: [{ key: 's5', label: 'SOCKS5', ok: false, detail: '服务端要求用户名密码,但没填' }], ok: false, isSocks5: true, raw: '' }; }
    const u = Buffer.from(line.username);
    const p = Buffer.from(line.password);
    s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const a = await readN(s, 2, 8000);
    if (!a || a.length < 2) { try { s.destroy(); } catch { /* */ } return { steps: [{ key: 's5', label: 'SOCKS5', ok: false, detail: '认证没有回应' }], ok: false, isSocks5: true, raw: '' }; }
    if (a[1] !== 0x00) { try { s.destroy(); } catch { /* */ } return { steps: [{ key: 's5', label: 'SOCKS5', ok: false, detail: `认证被拒(0x${a[1].toString(16)}):账号或密码不对` }], ok: false, isSocks5: true, raw: '' }; }
    steps.push({ key: 's5', label: 'SOCKS5', ok: true, detail: '问候与账号密码认证都通过' });
  } else if (g[1] === 0x00) {
    steps.push({ key: 's5', label: 'SOCKS5', ok: true, detail: '问候通过(服务端不需要认证)' });
  } else {
    try { s.destroy(); } catch { /* */ }
    return { steps: [{ key: 's5', label: 'SOCKS5', ok: false, detail: `服务端只提供了未知认证方式 0x${g[1].toString(16)}` }], ok: false, isSocks5: true, raw: '' };
  }
  const host = Buffer.from('www.gstatic.com');
  s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x01, 0xbb])]));
  const c = await readN(s, 10, 12_000);
  try { s.destroy(); } catch { /* */ }
  if (!c || c.length < 2) return { steps: [...steps, { key: 's5c', label: '建连测试', ok: false, detail: 'CONNECT 没有回应' }], ok: false, isSocks5: true, raw: '' };
  if (c[1] !== 0x00) return { steps: [...steps, { key: 's5c', label: '建连测试', ok: false, detail: `CONNECT 失败(rep=0x${c[1].toString(16)})` }], ok: false, isSocks5: true, raw: '' };
  steps.push({ key: 's5c', label: '建连测试', ok: true, detail: 'SOCKS5 CONNECT 成功,这条线路可以用了' });
  return { steps, ok: true, isSocks5: true, raw: '' };
}

// HTTP:GET / 看认证/来源
async function httpProbe(line: Line, mixedPort?: number): Promise<{ steps: LineTestStep[]; ok: boolean; raw: string }> {
  const o = await open(line, mixedPort);
  if (!o.sock) return { steps: [{ key: 'h', label: 'HTTP', ok: false, detail: o.error }], ok: false, raw: '' };
  const auth = line.username || line.password ? `Proxy-Authorization: Basic ${b64(`${line.username}:${line.password}`)}\r\n` : '';
  const text = await readText(o.sock, `GET ${line.server}:${line.port} HTTP/1.1\r\nHost: ${line.server}\r\n${auth}Connection: close\r\n\r\n`);
  try { o.sock.destroy(); } catch { /* */ }
  const st = statusOf(text);
  const err = errOf(text);
  if (!st) return { steps: [{ key: 'h', label: 'HTTP', ok: null, detail: '没有 HTTP 响应' }], ok: false, raw: text.slice(0, 300) };
  if (/authentication failed|invalid user|password/i.test(err)) return { steps: [{ key: 'h', label: 'HTTP', ok: false, detail: `认证被拒:${err}` }], ok: false, raw: text.slice(0, 300) };
  if (/allowIpList|banned|ip forbidden/i.test(err)) return { steps: [{ key: 'h', label: 'HTTP', ok: null, detail: `来源 IP 被拒:${err}` }], ok: false, raw: text.slice(0, 300) };
  if (st === 200 || st === 204) return { steps: [{ key: 'h', label: 'HTTP', ok: true, detail: `HTTP ${st},认证通过` }], ok: true, raw: text.slice(0, 300) };
  return { steps: [{ key: 'h', label: 'HTTP', ok: null, detail: `HTTP ${st}${err ? ':' + err : ''}` }], ok: false, raw: text.slice(0, 300) };
}

export async function testLine(line: Line, opts: { mixedPort?: number } = {}): Promise<LineTestResult> {
  const at = new Date().toISOString();
  const via: 'direct' | 'node' = opts.mixedPort ? 'node' : 'direct';
  if (line.type === 'none' || !line.server || !line.port) {
    return { at, via, protocol: 'unknown', steps: [{ key: 'cfg', label: '配置', ok: false, detail: '还没填静态 IP' }], raw: '' };
  }
  const reach = await open(line, opts.mixedPort);
  if (!reach.sock) {
    return {
      at, via, protocol: 'unknown',
      steps: [{ key: 'reach', label: '端口连通', ok: false, detail: via === 'node' ? `${reach.error}(节点到不了这个端口)` : `${reach.error}(网络不通,或供应商只接受海外来源)` }],
      raw: '',
    };
  }
  try { reach.sock.destroy(); } catch { /* */ }
  const base: LineTestStep[] = [{
    key: 'reach', label: '端口连通', ok: true,
    detail: via === 'node' ? `已经由订阅节点连到 ${line.server}:${line.port}` : `已直连到 ${line.server}:${line.port}`,
  }];

  const s5 = await socks5(line, opts.mixedPort);
  if (s5.ok || s5.isSocks5) return { at, via, protocol: 'socks5', steps: [...base, ...s5.steps], raw: s5.raw };
  const h = await httpProbe(line, opts.mixedPort);
  return { at, via, protocol: h.ok ? 'http' : 'unknown', steps: [...base, ...s5.steps, ...h.steps], raw: [s5.raw, h.raw].filter(Boolean).join('\n---\n') };
}

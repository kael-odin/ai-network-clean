// 经内核(→你的节点)连到静态代理,然后在隧道里发不同的请求,把对端的原始响应打出来
import net from 'node:net';

const [mixed, ph, pp, user, pass] = process.argv.slice(2);
const M = Number(mixed);
const b64 = Buffer.from(`${user}:${pass}`).toString('base64');

function tunnel() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: M, timeout: 20_000 });
    let buf = '';
    s.on('error', (e) => resolve({ ok: false, why: e.code }));
    s.on('timeout', () => resolve({ ok: false, why: 'timeout' }));
    s.once('connect', () => s.write(`CONNECT ${ph}:${pp} HTTP/1.1\r\nHost: ${ph}:${pp}\r\n\r\n`));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (/\r\n\r\n/.test(buf)) resolve({ ok: buf.startsWith('HTTP/1.1 200'), s, rest: buf.split('\r\n\r\n')[1] ?? '' });
    });
  });
}

async function run(label, request) {
  const t = await tunnel();
  if (!t.ok) { console.log(`${label}: 第一跳失败 ${t.why ?? ''}`); return; }
  const res = await new Promise((resolve) => {
    let out = '';
    t.s.on('data', (d) => { out += d.toString('latin1'); if (out.length > 600 || /\r\n\r\n/.test(out)) resolve(out); });
    t.s.on('close', () => resolve(out || '(关闭,无响应)'));
    t.s.on('error', (e) => resolve('(错误 ' + e.code + ')'));
    setTimeout(() => resolve(out || '(超时,无响应)'), 9000);
    t.s.write(request);
  });
  try { t.s.destroy(); } catch { /* */ }
  console.log(`\n=== ${label} ===`);
  console.log(res.slice(0, 500).replace(/\r/g, ''));
}

await run('GET /(看代理自身回复,不带认证)', 'GET / HTTP/1.1\r\nHost: ' + ph + '\r\nConnection: close\r\n\r\n');
await run('GET /(带 Basic 认证)', `GET / HTTP/1.1\r\nHost: ${ph}\r\nProxy-Authorization: Basic ${b64}\r\nConnection: close\r\n\r\n`);
await run('绝对地址 GET gstatic(带认证)', `GET http://www.gstatic.com/generate_204 HTTP/1.1\r\nHost: www.gstatic.com\r\nProxy-Authorization: Basic ${b64}\r\nConnection: close\r\n\r\n`);
await run('绝对地址 GET gstatic(不带认证)', 'GET http://www.gstatic.com/generate_204 HTTP/1.1\r\nHost: www.gstatic.com\r\nConnection: close\r\n\r\n');
await run('CONNECT 1.1.1.1:443(带认证)', `CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\nProxy-Authorization: Basic ${b64}\r\n\r\n`);

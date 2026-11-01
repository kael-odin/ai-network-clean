// 更细的探测:先看原始连通性和 banner,再分别试 SOCKS5(无认证/有认证)、HTTP CONNECT、HTTP 绝对地址请求
import net from 'node:net';

const [host, port, user, pass] = process.argv.slice(2);
const P = Number(port);
const b64 = Buffer.from(`${user}:${pass}`).toString('base64');

const connect = () => new Promise((resolve) => {
  const s = net.connect({ host, port: P, timeout: 10_000 });
  const out = { s, events: [] };
  s.once('connect', () => resolve({ ok: true, ...out }));
  s.once('timeout', () => resolve({ ok: false, why: 'timeout' }));
  s.once('error', (e) => resolve({ ok: false, why: e.code || e.message }));
});

// 1) banner
{
  const c = await connect();
  if (!c.ok) console.log('TCP 连接失败:', c.why);
  else {
    const banner = await new Promise((r) => {
      let got = false;
      c.s.once('data', (d) => { got = true; r(d); });
      c.s.once('close', () => { if (!got) r(null); });
      setTimeout(() => { if (!got) r(null); }, 3000);
    });
    console.log('TCP 连接成功;banner:', banner ? JSON.stringify(banner.subarray(0, 40).toString('latin1')) : '(无,3 秒内没有数据)');
    c.s.destroy();
  }
}

// 2) SOCKS5 只提供 no-auth
const socks = (methods) => new Promise((resolve) => {
  const s = net.connect({ host, port: P, timeout: 10_000 });
  let buf = Buffer.alloc(0);
  const done = (v) => { try { s.destroy(); } catch { /* */ } resolve(v); };
  s.on('error', (e) => done({ ok: false, why: e.code }));
  s.on('timeout', () => done({ ok: false, why: 'timeout' }));
  s.on('close', () => done({ ok: false, why: 'closed', buf: buf.toString('hex') }));
  s.once('connect', () => s.write(Buffer.from([0x05, methods.length, ...methods])));
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 2) return;
    if (buf[0] !== 0x05) return done({ ok: false, why: '不是 SOCKS5', first: buf.subarray(0, 8).toString('hex') });
    const sel = buf[1];
    if (sel === 0xff) return done({ ok: false, why: 'SOCKS5 拒绝了所有认证方式' });
    if (sel === 0x00) return done({ ok: true, stage: 'greeting', method: 0 });
    if (sel !== 0x02) return done({ ok: false, why: '未知认证方式 ' + sel });
    // 用户名密码认证
    const u = Buffer.from(user);
    const p = Buffer.from(pass);
    s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    s.on('data', (d2) => {
      buf = Buffer.concat([buf, d2]);
      const auth = buf.subarray(buf.length - d2.length);
      if (auth[1] === 0x00) return done({ ok: true, stage: 'auth', method: 2 });
      done({ ok: false, why: 'SOCKS5 认证失败 code=' + auth[1] });
    });
  });
});
console.log('SOCKS5(仅 no-auth):', JSON.stringify(await socks([0x00])));
console.log('SOCKS5(no-auth+user/pass):', JSON.stringify(await socks([0x00, 0x02])));
console.log('SOCKS5(仅 user/pass):', JSON.stringify(await socks([0x02])));

// 3) HTTP CONNECT
const httpTry = (text, label) => new Promise((resolve) => {
  const s = net.connect({ host, port: P, timeout: 10_000 });
  let buf = '';
  const done = (v) => { try { s.destroy(); } catch { /* */ } resolve(v); };
  s.on('error', (e) => done({ ok: false, why: e.code }));
  s.on('timeout', () => done({ ok: false, why: 'timeout' }));
  s.on('close', () => done({ ok: false, why: 'closed', got: buf.slice(0, 120) }));
  s.once('connect', () => s.write(text));
  s.on('data', (d) => {
    buf += d.toString('latin1');
    if (buf.includes('\r\n\r\n')) done({ ok: /^HTTP\/1\.[01] 200/.test(buf), line: buf.split('\r\n')[0], got: buf.slice(0, 200) });
  });
});
console.log('HTTP CONNECT+auth:', JSON.stringify(await httpTry(`CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\nProxy-Authorization: Basic ${b64}\r\n\r\n`, 'connect')));
console.log('HTTP 绝对地址+auth:', JSON.stringify(await httpTry(`GET http://www.gstatic.com/generate_204 HTTP/1.1\r\nHost: www.gstatic.com\r\nProxy-Authorization: Basic ${b64}\r\nConnection: close\r\n\r\n`, 'get')));

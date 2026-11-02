// 探测静态 IP 代理的协议(SOCKS5 / HTTP),并验证认证是否通过
import net from 'node:net';
import { createHash } from 'node:crypto';

const [host, port, user, pass] = process.argv.slice(2);
const P = Number(port);

const b64 = Buffer.from(`${user}:${pass}`).toString('base64');

function socks5() {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: P, timeout: 8000 });
    const done = (r) => { try { s.destroy(); } catch { /* */ } resolve(r); };
    s.on('error', (e) => done({ ok: false, why: 'connect:' + e.code }));
    s.on('timeout', () => done({ ok: false, why: 'timeout' }));
    s.once('connect', () => {
      s.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      s.once('data', (sel) => {
        if (sel[0] !== 0x05) return done({ ok: false, why: 'not socks5' });
        const method = sel[1];
        const afterAuth = () => {
          // CONNECT 1.1.1.1:443
          const req = Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0x01, 0xbb]);
          s.write(req);
          s.once('data', (rep) => {
            if (rep[0] !== 0x05) return done({ ok: false, why: 'bad reply' });
            done({ ok: rep[1] === 0x00, method, code: rep[1] });
          });
        };
        if (method === 0x02) {
          const u = Buffer.from(user);
          const p = Buffer.from(pass);
          s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          s.once('data', (auth) => {
            if (auth[1] !== 0x00) return done({ ok: false, method, why: 'auth failed code=' + auth[1] });
            afterAuth();
          });
        } else afterAuth();
      });
    });
  });
}

function httpConnect() {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: P, timeout: 8000 });
    const done = (r) => { try { s.destroy(); } catch { /* */ } resolve(r); };
    let buf = '';
    s.on('error', (e) => done({ ok: false, why: 'connect:' + e.code }));
    s.on('timeout', () => done({ ok: false, why: 'timeout' }));
    s.once('connect', () => {
      s.write(`CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\nProxy-Authorization: Basic ${b64}\r\nProxy-Connection: keep-alive\r\n\r\n`);
      s.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          const line = buf.split('\r\n')[0];
          const code = Number(line.split(' ')[1]);
          done({ ok: code === 200, code, line });
        }
      });
    });
  });
}

const r1 = await socks5();
console.log('SOCKS5:', JSON.stringify(r1));
const r2 = await httpConnect();
console.log('HTTP  :', JSON.stringify(r2));

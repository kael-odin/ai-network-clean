// 经内核(→当前节点)对目标做一次 SOCKS5 握手 + CONNECT,打印完整握手结果
const net = require('node:net');
const [, , mixedPortArg, host, portArg, user, pass] = process.argv;
const M = Number(mixedPortArg);
const P = Number(portArg);

function tunnel(toHost, toPort) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: M, timeout: 20_000 });
    let buf = '';
    s.on('error', (e) => resolve({ ok: false, why: e.code }));
    s.once('connect', () => s.write(`CONNECT ${toHost}:${toPort} HTTP/1.1\r\nHost: ${toHost}:${toPort}\r\n\r\n`));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (/\r\n\r\n/.test(buf)) resolve(/^HTTP\/1\.1 200/.test(buf) ? { ok: true, s } : { ok: false, why: buf.split('\r\n')[0] });
    });
    s.on('timeout', () => resolve({ ok: false, why: 'timeout' }));
  });
}

function once(sock, expectLen) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => resolve({ timeout: true, buf }), 12_000);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= expectLen) { clearTimeout(t); sock.removeListener('data', onData); resolve({ buf }); }
    };
    sock.on('data', onData);
    sock.once('close', () => { clearTimeout(t); resolve({ closed: true, buf }); });
    sock.once('error', () => { clearTimeout(t); resolve({ closed: true, buf }); });
  });
}

(async () => {
  const t = await tunnel(host, P);
  if (!t.ok) { console.log('隧道失败:', t.why); return; }
  const s = t.s;
  console.log('隧道已建立(经节点)');

  s.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  let r = await once(s, 2);
  if (r.timeout) { console.log('问候无响应(可能被丢弃)'); s.destroy(); return; }
  if (r.closed) { console.log('问候后连接被关闭,收到:', r.buf.toString('latin1').slice(0, 120)); s.destroy(); return; }
  const [ver, method] = r.buf;
  console.log(`问候回复: ver=${ver} method=0x${method.toString(16)}`);
  if (ver !== 5) { console.log('不是 SOCKS5:', r.buf.toString('latin1').slice(0, 120)); s.destroy(); return; }

  if (method === 0x02) {
    const u = Buffer.from(user), p = Buffer.from(pass);
    s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    r = await once(s, 2);
    if (r.timeout || r.closed) { console.log('认证无响应/关闭'); s.destroy(); return; }
    console.log(`认证回复: ${r.buf[1] === 0 ? '成功' : '失败 code=' + r.buf[1]}`);
    if (r.buf[1] !== 0) { s.destroy(); return; }
  } else if (method === 0x00) {
    console.log('服务端不需要认证');
  } else {
    console.log('服务端选了未知方法 0x' + method.toString(16)); s.destroy(); return;
  }

  // CONNECT www.gstatic.com:443
  const hostBuf = Buffer.from('www.gstatic.com');
  s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, Buffer.from([0x01, 0xbb])]));
  r = await once(s, 10);
  if (r.timeout || r.closed) { console.log('CONNECT 无响应/关闭'); s.destroy(); return; }
  console.log(`CONNECT 回复: rep=0x${r.buf[1].toString(16)} ${r.buf[1] === 0 ? '成功 ✅' : '失败'}`);
  s.destroy();
})();

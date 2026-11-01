// 决定性测试:先经本机内核(→你的订阅节点)连到静态代理,再用 Basic 认证向它发 CONNECT
// 用法: node tools/probe-chain.mjs <mixedPort> <proxyHost> <proxyPort> <user> <pass> [targetHost] [targetPort]
import net from 'node:net';

const [mixed, ph, pp, user, pass, th = 'www.cloudflare.com', tp = '443'] = process.argv.slice(2);
const M = Number(mixed);
const b64 = Buffer.from(`${user}:${pass}`).toString('base64');

function httpConnectVia(proxyPort, dstHost, dstPort, extra = '') {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: proxyPort, timeout: 25_000 });
    let buf = '';
    const done = (v) => { try { s.destroy(); } catch { /* */ } resolve(v); };
    s.on('error', (e) => done({ ok: false, why: e.code }));
    s.on('timeout', () => done({ ok: false, why: 'timeout' }));
    s.on('close', () => done({ ok: false, why: 'closed', got: buf.slice(0, 300) }));
    s.once('connect', () => s.write(`CONNECT ${dstHost}:${dstPort} HTTP/1.1\r\nHost: ${dstHost}:${dstPort}\r\n${extra}\r\n`));
    s.on('data', (d) => {
      buf += d.toString('latin1');
      const line = buf.split('\r\n')[0];
      if (/\r\n\r\n/.test(buf) || line) {
        const code = Number((line || '').split(' ')[1]);
        if (code) done({ ok: code === 200, code, line, got: buf.slice(0, 300) });
      }
    });
  });
}

// 1) 经内核 CONNECT 到静态代理(这一步只证明「节点能到代理」)
console.log('经节点连静态代理 …');
const hop = await httpConnectVia(M, ph, Number(pp));
console.log('  结果:', JSON.stringify(hop).slice(0, 300));
if (!hop.ok) process.exit(0);

// 2) 在到静态代理的 TCP 上,再发一次 CONNECT(带认证)= 完整链路
console.log('\n经节点 + 认证,向静态代理 CONNECT 目标 …');
const chain = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: M, timeout: 30_000 });
  let buf = '';
  const done = (v) => { try { s.destroy(); } catch { /* */ } resolve(v); };
  s.on('error', (e) => done({ ok: false, why: e.code }));
  s.on('timeout', () => done({ ok: false, why: 'timeout', got: buf.slice(0, 400) }));
  s.on('close', () => done({ ok: false, why: 'closed', got: buf.slice(0, 400) }));
  s.once('connect', () => s.write(`CONNECT ${ph}:${pp} HTTP/1.1\r\nHost: ${ph}:${pp}\r\n\r\n`));
  let stage = 0;
  s.on('data', (d) => {
    buf += d.toString('latin1');
    if (stage === 0) {
      if (!/\r\n\r\n/.test(buf)) return;
      const line = buf.split('\r\n')[0];
      const code = Number(line.split(' ')[1]);
      if (code !== 200) return done({ ok: false, stage: 'hop', line, got: buf.slice(0, 300) });
      buf = '';
      stage = 1;
      s.write(`CONNECT ${th}:${tp} HTTP/1.1\r\nHost: ${th}:${tp}\r\nProxy-Authorization: Basic ${b64}\r\nProxy-Connection: keep-alive\r\n\r\n`);
      return;
    }
    if (stage === 1) {
      if (!/\r\n\r\n/.test(buf)) return;
      const line = buf.split('\r\n')[0];
      const code = Number(line.split(' ')[1]);
      done({ ok: code === 200, stage: 'proxy', code, line, got: buf.slice(0, 400) });
    }
  });
});
console.log('  结果:', JSON.stringify(chain, null, 2));

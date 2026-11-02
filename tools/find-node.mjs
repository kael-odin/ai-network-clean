// 找出「经哪个节点能用静态 IP」:列出候选节点 → 逐个取出口 IP → 并经它向静态 IP 发带认证的请求
import net from 'node:net';

const port = Number(process.argv[2] ?? 9333);
const [ph, pp, user, pass] = process.argv.slice(3);
const b64 = Buffer.from(`${user}:${pass}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html') && !String(t.url).includes('#tray'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value;

// 经内核(当前节点)访问 cdnjs 的 trace,拿到节点出口 IP
async function nodeExit(mixed) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: mixed, timeout: 20_000 });
    let buf = '';
    const t = setTimeout(() => { try { s.destroy(); } catch { /* */ } resolve(null); }, 20_000);
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.once('connect', () => s.write('CONNECT cdnjs.cloudflare.com:443 HTTP/1.1\r\nHost: cdnjs.cloudflare.com:443\r\n\r\n'));
    let stage = 0;
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (stage === 0) {
        if (!/\r\n\r\n/.test(buf)) return;
        if (!buf.startsWith('HTTP/1.1 200')) { clearTimeout(t); try { s.destroy(); } catch { /* */ } resolve(null); return; }
        buf = ''; stage = 1;
        // 用 TLS 握手太麻烦:直接让内核 CONNECT 到 http 的 trace? cdnjs 只有 https。
        // 换成:再 CONNECT 一次到 http://www.gstatic.com:80,读 204 的 ip? 不如用 ipify 的 http 入口(支持 80)
        try { s.destroy(); } catch { /* */ }
        clearTimeout(t);
        resolve('tls-needed');
      }
    });
  });
}

// 直接问内核:当前所有连接里,普通代理那条线的出口(用 trace 域名,走 node 规则)
async function nodeExitViaHttp(mixed) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: mixed, timeout: 20_000 });
    let buf = '';
    const t = setTimeout(() => { try { s.destroy(); } catch { /* */ } resolve(null); }, 20_000);
    s.on('error', () => { clearTimeout(t); resolve(null); });
    s.once('connect', () => s.write('GET http://checkip.amazonaws.com/ HTTP/1.1\r\nHost: checkip.amazonaws.com\r\nConnection: close\r\n\r\n'));
    s.on('data', (d) => { buf += d.toString('latin1'); });
    s.on('close', () => { clearTimeout(t); const m = buf.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/); resolve(m ? m[1] : null); });
  });
}

async function probeProxy(mixed) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: mixed, timeout: 30_000 });
    let buf = '';
    const t = setTimeout(() => { try { s.destroy(); } catch { /* */ } resolve('超时'); }, 30_000);
    s.on('error', () => { clearTimeout(t); resolve('hop 失败'); });
    s.once('connect', () => s.write(`CONNECT ${ph}:${pp} HTTP/1.1\r\nHost: ${ph}:${pp}\r\n\r\n`));
    let stage = 0;
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (stage === 0) {
        if (!/\r\n\r\n/.test(buf)) return;
        if (!buf.startsWith('HTTP/1.1 200')) { clearTimeout(t); try { s.destroy(); } catch { /* */ } resolve('hop: ' + buf.split('\r\n')[0]); return; }
        buf = ''; stage = 1;
        s.write(`GET / HTTP/1.1\r\nHost: ${ph}\r\nProxy-Authorization: Basic ${b64}\r\nConnection: close\r\n\r\n`);
        return;
      }
      const m = buf.match(/errorMsg: ?([^\r\n]*)/);
      if (m) { clearTimeout(t); try { s.destroy(); } catch { /* */ } resolve(m[1]); }
    });
    s.on('close', () => { clearTimeout(t); const m = buf.match(/errorMsg: ?([^\r\n]*)/); resolve(m ? m[1] : (buf ? buf.split('\r\n')[0] : '关闭,无响应')); });
  });
}

await ev('(async () => { await window.ain.connect(); return true })()');
let s;
for (let i = 0; i < 90; i++) { await sleep(1000); s = await ev('(async () => await window.ain.state())()'); if (s.conn.status === 'connected') break; }
if (s.conn.status !== 'connected') { console.log('连接失败:', s.conn.error, s.conn.warning); process.exit(1); }
console.log('connected mode=', s.conn.mode, 'mixed=', s.settings.mixedPort);
await ev('(async () => { await window.ain.refreshNodes(); return true })()');
s = await ev('(async () => await window.ain.state())()');
const nodes = s.nodes?.nodes ?? [];
const picks = nodes.filter((n) => /美国|US|United States|洛杉矶|圣何塞|California|加州/i.test(n.name) && !/到期|套餐|官网|剩余|流量|下载|Ver\./i.test(n.name)).slice(0, 4);
const others = nodes.filter((n) => /香港|日本|新加坡|台湾|韩国/i.test(n.name) && !/到期|套餐|官网|剩余|流量|下载|Ver\./i.test(n.name)).slice(0, 2);
const candidates = [...picks, ...others];
console.log('候选节点:', candidates.map((n) => n.name));

for (const n of candidates) {
  await ev(`(async () => { await window.ain.selectNode(${JSON.stringify(n.name)}); return true })()`);
  await sleep(3000);
  const exit = await nodeExitViaHttp(s.settings.mixedPort);
  const resp = await probeProxy(s.settings.mixedPort);
  console.log(`\n${n.name}\n  出口 IP: ${exit}\n  静态IP 回复: ${resp}`);
}
await ev('(async () => { await window.ain.disconnect(); return true })()');
ws.close();

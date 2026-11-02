// 测试用最小 SOCKS5 服务(无认证,直接转发),充当「静态 IP」的出口
import net from 'node:net';

const port = Number(process.argv[2] ?? 1080);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const srv = net.createServer((c) => {
  c.once('data', (greet) => {
    if (greet[0] !== 0x05) { c.destroy(); return; }
    c.write(Buffer.from([0x05, 0x00])); // 不需要认证
    c.once('data', (req) => {
      if (req[0] !== 0x05) { c.destroy(); return; }
      const cmd = req[1];
      const atyp = req[3];
      let host;
      let off;
      if (atyp === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
      else if (atyp === 3) { const l = req[4]; host = req.subarray(5, 5 + l).toString(); off = 5 + l; }
      else {
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(req.readUInt16BE(4 + i * 2).toString(16));
        host = parts.join(':'); off = 20;
      }
      const dport = req.readUInt16BE(off);
      if (cmd !== 1) { c.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return; }
      log('CONNECT', host + ':' + dport);
      const up = net.connect({ host, port: dport }, () => {
        c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        up.pipe(c);
        c.pipe(up);
      });
      up.on('error', () => { try { c.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* 已经关了 */ } });
      c.on('error', () => up.destroy());
      c.on('close', () => up.destroy());
      up.on('close', () => c.destroy());
    });
  });
  c.on('error', () => { /* 客户端断开 */ });
});

srv.listen(port, '127.0.0.1', () => log(`socks5 listening 127.0.0.1:${port}`));

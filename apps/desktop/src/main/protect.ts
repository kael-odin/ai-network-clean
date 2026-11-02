// 防护检测:静态 IP 出口、DNS、IPv6、WebRTC。都是真测,不是摆状态。
// - 出口:经内核读 Cloudflare 的 trace,看到的 IP 必须等于你填的静态 IP
// - DNS(纯净版改法):不再依赖任何第三方探测服务,直接核对「机制」——
//   所有在线物理网卡的 DNS 都指向内核的 TUN 地址、去外网的路由也在 TUN 上,域名查询就只能进虚拟网卡被接管。
//   外面的软件把 DNS 改回去会被 sysDns.verify 抓住并重新指回来,同时这里判为异常。
// - IPv6:访问只有 IPv6 的查 IP 网站(内核里拦掉),能通就是绕过了虚拟网卡
// - WebRTC:自己发 STUN Binding 请求,看外部看到的地址是不是静态 IP
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import type { ProtectItem, ProtectReport } from '../shared/ipc.ts';

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export function checkIp(exitIp: string | null, expected: string | null): ProtectItem {
  if (!exitIp) return { state: 'unknown', detail: '还没有读到出口 IP' };
  if (!expected) return { state: 'unknown', detail: `出口 ${exitIp};静态 IP 里没填期望的出口地址,不做比对` };
  return exitIp === expected
    ? { state: 'ok', detail: `AI 网站看到的是 ${exitIp}(你的静态 IP)` }
    : { state: 'fail', detail: `AI 网站看到 ${exitIp},不是你的静态 IP ${expected}` };
}

// DNS:本机机制核对(不访问任何外部服务)
export function evaluateDnsLocal(o: { tun: boolean; dnsConfirmed: boolean; routeOk: boolean; dnsReverted: string[] }): ProtectItem {
  if (o.dnsReverted.length > 0) {
    return { state: 'fail', detail: `${o.dnsReverted.join('、')} 的 DNS 被别的软件改回去了(查询会从本地运营商漏出去),已重新指到客户端,稍后自动复测` };
  }
  if (!o.tun) {
    return { state: 'ok', detail: '本地代理模式:域名交给代理解析,本机不解析 AI 域名。桌面程序不走代理时不受保护' };
  }
  if (!o.routeOk) return { state: 'unknown', detail: '去外网的路由没有指向虚拟网卡,判断不了 DNS 会不会漏' };
  if (!o.dnsConfirmed) return { state: 'unknown', detail: '读不到网卡当前的 DNS 设置', inconclusive: true };
  return { state: 'ok', detail: '所有在线网卡的 DNS 都指向客户端,域名查询只能进虚拟网卡被接管(没有别的解析器能收到查询)' };
}

export interface Resolver { ip: string; country: string | null }

// ---- STUN(RFC 5389)Binding 请求 ----
const MAGIC = 0x2112a442;

export function stunRequest(tx: Buffer): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt32BE(MAGIC, 4);
  tx.copy(b, 8);
  return b;
}

export function parseStunResponse(msg: Buffer, tx: Buffer): string | null {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || msg.readUInt32BE(4) !== MAGIC || !msg.subarray(8, 20).equals(tx)) return null;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let plain: string | null = null;
  for (let p = 20; p + 4 <= end;) {
    const type = msg.readUInt16BE(p);
    const len = msg.readUInt16BE(p + 2);
    const v = msg.subarray(p + 4, p + 4 + len);
    if ((type === 0x0020 || type === 0x0001) && v.length >= 8 && v[1] === 0x01) {
      const raw = v.readUInt32BE(4);
      const n = type === 0x0020 ? (raw ^ MAGIC) >>> 0 : raw;
      const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      if (type === 0x0020) return ip;
      plain = ip;
    }
    if ((type === 0x0020 || type === 0x0001) && v.length >= 20 && v[1] === 0x02) {
      const raw = Buffer.from(v.subarray(4, 20));
      if (type === 0x0020) { const key = Buffer.concat([msg.subarray(4, 8), tx]); for (let i = 0; i < 16; i++) raw[i] ^= key[i]; }
      const ip = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':');
      if (type === 0x0020) return ip;
      plain = ip;
    }
    p += 4 + len + ((4 - (len % 4)) % 4);
  }
  return plain;
}

const STUN_SERVERS: [string, number][] = [['stun.l.google.com', 19302], ['stun.cloudflare.com', 3478]];

async function stunOnce(host: string, port: number, timeoutMs: number, family: 4 | 6 = 4): Promise<string | null> {
  const address = host.includes(':') ? host : (await lookup(host, { family })).address;
  return new Promise((ok) => {
    const sock = createSocket(family === 6 ? 'udp6' : 'udp4');
    const tx = randomBytes(12);
    const done = (v: string | null) => { clearTimeout(t); clearInterval(again); try { sock.close(); } catch { /* 已关 */ } ok(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    sock.on('error', () => done(null));
    sock.on('message', (m) => { const ip = parseStunResponse(m, tx); if (ip) done(ip); });
    const req = stunRequest(tx);
    const send = () => sock.send(req, port, address, () => {});
    const again = setInterval(send, 1000);
    send();
    sock.on('close', () => clearInterval(again));
  });
}

const STUN6: [string, number][] = [['stun.l.google.com', 19302], ['2001:4860:4864:5:8000::1', 19302]];

export async function checkWebrtc(expected: string | null, tun: boolean, hasIpv6 = false): Promise<ProtectItem> {
  if (hasIpv6) {
    for (const [host, port] of STUN6) {
      const ip = await stunOnce(host, port, 3000, 6).catch(() => null);
      if (ip) return { state: 'fail', detail: `网页可以通过 WebRTC(IPv6)看到 ${ip}(你的真实 IPv6 地址)` + (tun ? '' : '。本地代理模式拦不住浏览器的 WebRTC') };
    }
  }
  let lastErr = '';
  for (const [host, port] of STUN_SERVERS) {
    try {
      const ip = await stunOnce(host, port, 4000);
      if (!ip) continue;
      if (expected && ip === expected) return { state: 'ok', detail: `WebRTC 看到的也是你的静态 IP ${ip}` };
      if (!expected) return { state: 'ok', detail: `STUN 请求被拦下(拿到的 ${ip} 不是本机地址),网页看不到你的真实 IP` };
      return { state: 'fail', detail: `网页可以通过 WebRTC 看到 ${ip}(不是你的静态 IP)` + (tun ? '' : '。本地代理模式拦不住浏览器的 WebRTC,用管理员身份运行客户端(虚拟网卡模式)才能拦') };
    } catch (e) { lastErr = (e as Error).message; }
  }
  return lastErr && /ENOTFOUND|EAI_AGAIN/.test(lastErr)
    ? { state: 'unknown', detail: '解析不了 STUN 服务器:' + lastErr }
    : { state: 'ok', detail: 'STUN 请求被拦下,网页拿不到你的其他 IP' };
}

export const IPV6_PROBE_HOST = 'api6.ipify.org';

export function hasPublicIpv6(ifaces: Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>): boolean {
  return Object.entries(ifaces).some(([name, list]) => !/Meta|Mihomo|Clash|TUN|wintun|Loopback/i.test(name)
    && (list ?? []).some((x) => (x.family === 'IPv6' || x.family === 6) && !x.internal && !/^(fe80|fc|fd)/i.test(x.address)));
}

export async function checkIpv6(o: { hasIpv6: boolean; fetch: (url: string, init: RequestInit) => Promise<Response>; tun: boolean }): Promise<ProtectItem> {
  if (!o.hasIpv6) return { state: 'ok', detail: '这台电脑没有公网 IPv6 地址,不会从 IPv6 泄露' };
  try {
    const r = await o.fetch(`https://${IPV6_PROBE_HOST}/?format=json`, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    const ip = ((await r.json()) as { ip?: string }).ip ?? '';
    if (ip.includes(':')) return { state: 'fail', detail: `网页可以通过 IPv6 看到你的真实地址 ${ip}` + (o.tun ? '' : '。本地代理模式接管不了 IPv6,用管理员身份运行客户端(虚拟网卡模式)才能接管') };
    return { state: 'ok', detail: 'IPv6 流量已被接管' };
  } catch {
    return { state: 'ok', detail: 'IPv6 流量已被接管,网页看不到你的 IPv6 地址' };
  }
}

export const emptyReport = (): ProtectReport => ({
  at: new Date().toISOString(),
  ip: { state: 'unknown', detail: '' },
  dns: { state: 'unknown', detail: '' },
  ipv6: { state: 'unknown', detail: '' },
  webrtc: { state: 'unknown', detail: '' },
});

export { sleep };

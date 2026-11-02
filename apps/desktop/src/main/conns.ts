// 连接记录(PM 10-30,用户呼声高):像 Clash Verge 的「连接」页,列出每条连接访问的网站、哪个程序、走的哪条线,
// 让用户亲眼看到 Claude 确实走独享 IP。数据来自内核的 /connections;断开的连接内核不再给,由这里留最近一批。
// 线路名用大白话(独享 IP / 你的节点 / 直连 / 已拦截),不显示内部组名
import { AI_GATE, AI_GROUP } from './config.ts';

// 内核 /connections 里每条连接的样子(只取用得到的字段)
export interface RawConn {
  id: string;
  metadata: { host?: string; destinationIP?: string; destinationPort?: string; process?: string; network?: string };
  upload: number; download: number; start: string; chains: string[]; rule: string; rulePayload: string;
}
import type { Conn, RouteKind } from '../shared/ipc.ts';
export type { Conn };

// AI 服务按域名认:用户关心的是「Claude 的连接」
const SERVICES: [string, RegExp][] = [
  ['Claude', /(^|\.)(claude\.ai|claude\.com|anthropic\.com|claudeusercontent\.com|clau\.de)$/i],
  ['ChatGPT', /(^|\.)(openai\.com|chatgpt\.com|oaistatic\.com|oaiusercontent\.com)$/i],
  ['Gemini', /(^|\.)(gemini\.google\.com|generativelanguage\.googleapis\.com|aistudio\.google\.com)$/i],
];
export const serviceOf = (host: string): string | null => SERVICES.find(([, re]) => re.test(host))?.[0] ?? null;

// chains 由内往外:[实际出口节点, …, 规则选中的组]
export function routeOf(chains: string[]): { route: RouteKind; node: string | null } {
  if (chains.includes('REJECT') || chains.includes('REJECT-DROP')) return { route: 'blocked', node: null };
  if (chains.includes(AI_GROUP) || chains.includes(AI_GATE)) return { route: 'ip', node: null };
  if (chains[0] === 'DIRECT') return { route: 'direct', node: null };
  return { route: 'node', node: chains[0] ?? null };
}

export function toConn(c: RawConn): Conn {
  const host = c.metadata.host || c.metadata.destinationIP || '';
  return {
    id: c.id, host, port: c.metadata.destinationPort ?? '', process: (c.metadata.process ?? '').replace(/\.exe$/i, ''),
    service: serviceOf(host), ...routeOf(c.chains ?? []), start: c.start, closedAt: null, up: c.upload, down: c.download,
  };
}

const KEEP_CLOSED = 500;
const KEEP_MS = 60 * 60_000;

// 记着上一轮还在的连接;这一轮不见了的就是断开了,挪进「已断开」(最多留 500 条、1 小时)
export function createConnTracker(now: () => number = Date.now) {
  let active = new Map<string, Conn>();
  let closed: Conn[] = [];
  return {
    update(raw: RawConn[]): void {
      const next = new Map<string, Conn>();
      for (const r of raw) next.set(r.id, toConn(r));
      const at = new Date(now()).toISOString();
      const gone = [...active.values()].filter((c) => !next.has(c.id)).map((c) => ({ ...c, closedAt: at }));
      const cutoff = now() - KEEP_MS;
      closed = [...gone, ...closed].filter((c) => Date.parse(c.closedAt!) >= cutoff).slice(0, KEEP_CLOSED);
      active = next;
    },
    // 断开连接(内核停了):正在连的全部算断开
    clear(): void { this.update([]); },
    list(): { active: Conn[]; closed: Conn[] } {
      return { active: [...active.values()].sort((a, b) => b.start.localeCompare(a.start)), closed };
    },
    // 首页一句话:过去 1 小时某个服务一共多少条连接、几条没走独享 IP(没走的应该是 0,被拦的不算没走)
    summary(service: string): { total: number; offIp: number } {
      const cutoff = now() - KEEP_MS;
      const all = [...active.values(), ...closed].filter((c) => c.service === service && Date.parse(c.start) >= cutoff);
      return { total: all.length, offIp: all.filter((c) => c.route === 'node' || c.route === 'direct').length };
    },
  };
}
export type ConnTracker = ReturnType<typeof createConnTracker>;

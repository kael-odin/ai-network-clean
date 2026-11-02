// 分流测试:按浏览器的网络路径访问三条线上的网站,线路从内核连接记录里读,
// 一眼看出「AI 走静态 IP、其他国外网站走节点、国内直连」是不是都走对了
import { routeOf } from './conns.ts';
import type { SplitRow } from '../shared/ipc.ts';
import type { RawConnLike } from './mihomo.ts';

export type Lane = 'ai' | 'foreign' | 'cn' | 'custom';
export interface SplitTarget {
  lane: Lane;
  name: string;
  url: string;
  trace?: string;
  expect?: SplitRow['expect'];
}

export const TARGETS: SplitTarget[] = [
  { lane: 'ai', name: 'Claude', url: 'https://claude.ai/cdn-cgi/trace', trace: 'https://claude.ai/cdn-cgi/trace' },
  { lane: 'ai', name: 'ChatGPT', url: 'https://chatgpt.com/cdn-cgi/trace', trace: 'https://chatgpt.com/cdn-cgi/trace' },
  { lane: 'ai', name: 'Gemini', url: 'https://gemini.google.com/' },
  { lane: 'foreign', name: 'Google', url: 'https://www.google.com/generate_204' },
  { lane: 'foreign', name: 'YouTube', url: 'https://www.youtube.com/generate_204' },
  { lane: 'foreign', name: 'GitHub', url: 'https://github.com/' },
  // 国外这条线的出口:cdnjs 不在任何 AI 规则里,按普通网站走,读它的 trace 就是节点的出口
  { lane: 'foreign', name: '国外出口', url: 'https://cdnjs.cloudflare.com/cdn-cgi/trace', trace: 'https://cdnjs.cloudflare.com/cdn-cgi/trace' },
  { lane: 'cn', name: '百度', url: 'https://www.baidu.com/' },
  { lane: 'cn', name: 'B 站', url: 'https://www.bilibili.com/' },
  { lane: 'cn', name: '淘宝', url: 'https://www.taobao.com/' },
];

export const parseTrace = (text: string): { ip: string | null; country: string | null } => ({
  ip: text.match(/^ip=(.+)$/m)?.[1]?.trim() ?? null,
  country: text.match(/^loc=(.+)$/m)?.[1]?.trim() ?? null,
});

export interface SplitDeps {
  fetch: (url: string, readBody: boolean) => Promise<{ status: number; body: string }>;
  connections: () => Promise<RawConnLike[]>;
  hasLine: boolean;   // 有静态 IP:AI 应走静态 IP
  hasSubs: boolean;   // 有订阅:其他国外网站应走节点
  now?: () => number;
}

const expectOf = (lane: Lane, d: SplitDeps): SplitRow['expect'] =>
  lane === 'ai' ? (d.hasLine ? 'ip' : d.hasSubs ? 'node' : 'direct') : lane === 'foreign' ? (d.hasSubs ? 'node' : 'direct') : 'direct';

export async function runSplitTest(deps: SplitDeps, targets: SplitTarget[] = TARGETS): Promise<SplitRow[]> {
  const now = deps.now ?? Date.now;
  return Promise.all(targets.map(async (t): Promise<SplitRow> => {
    const host = new URL(t.url).hostname;
    const expect = t.expect ?? expectOf(t.lane, deps);
    const t0 = now();
    let ok = false; let status: number | null = null; let body = '';
    try {
      const r = await deps.fetch(t.url, !!t.trace);
      status = r.status; body = r.body; ok = r.status > 0 && r.status < 500;
    } catch { /* 打不开 */ }
    const ms = ok ? now() - t0 : null;
    let route: SplitRow['route'] = null; let node: string | null = null;
    try {
      const hit = (await deps.connections()).filter((c) => (c.metadata.host || c.metadata.destinationIP) === host).sort((a, b) => b.start.localeCompare(a.start))[0];
      if (hit) ({ route, node } = routeOf(hit.chains ?? []));
      else if (ok) route = 'outside';
    } catch { /* 内核没响应 */ }
    const { ip, country } = t.trace && ok ? parseTrace(body) : { ip: null, country: null };
    return { lane: t.lane, name: t.name, host, ok, ms, status, route, node, ip, country, expect, good: ok && route === expect };
  }));
}

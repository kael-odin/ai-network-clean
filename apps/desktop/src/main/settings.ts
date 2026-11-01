// 设置:明文 JSON 存在用户数据目录(订阅链接按 Clash 的惯例也是明文)
// 只收已知字段和合法值,旧数据/手改坏了都退回默认,不让坏配置进内核
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiRoute, Line, Settings, Sub, UserRule } from '../shared/ipc.ts';

const PATH_TYPES = ['socks5', 'http', 'none'] as const;
const TUN_MODES = ['auto', 'on', 'off'] as const;
const ROUTES = ['static', 'node', 'direct'] as const;
// 域名:字母数字和点、横线,至少有一个点
export const RULE_DOMAIN = /^(?=.{3,120}$)([a-z0-9-]+\.)+[a-z0-9-]{2,}$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
const SAFE_SECRET = /^[^\s,#"'\\]{0,128}$/;

export const EMPTY_LINE: Line = { type: 'none', server: '', port: 0, username: '', password: '', exitIp: '', viaNode: false };

// 开机启动默认关、自动连接默认开:纯净版不主动往系统里塞东西,但连上以后希望它是"打开就能用"的
export const DEFAULT_SETTINGS: Settings = {
  autoStart: false,
  autoConnect: true,
  keepBackground: true,
  tun: 'auto',
  mixedPort: 17897,
  controllerPort: 19797,
  line: { ...EMPTY_LINE },
  subs: [],
  ownNode: '',
  aiRoutes: { chatgpt: 'static', gemini: 'static', grok: 'node', meta: 'node' },
  rules: [],
  autoRegion: '',
  homeRegion: 'CN',
  claudeCodeFix: true,
  webFollowRegion: true,
  favNodes: [],
  fpNoise: false,   // 默认关:注入脚本会让页面多加载一次,CF 挑战期间容易出问题
  fpSeed: 0,
};

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const clampPort = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : d;
};

export function validSubUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch {
    return false;
  }
}

export function subName(url: string): string {
  try {
    return new URL(url).host.replace(/:\d+$/, '');
  } catch {
    return '节点订阅';
  }
}

function pickLine(v: unknown): Line {
  const l = (v ?? {}) as Partial<Line>;
  const type = PATH_TYPES.includes(l.type as (typeof PATH_TYPES)[number]) ? (l.type as Line['type']) : 'none';
  const server = typeof l.server === 'string' ? l.server.trim().slice(0, 253) : '';
  const port = Number(l.port);
  const username = typeof l.username === 'string' && SAFE_SECRET.test(l.username) ? l.username.trim() : '';
  const password = typeof l.password === 'string' && SAFE_SECRET.test(l.password) ? l.password : '';
  const exitIpRaw = typeof l.exitIp === 'string' ? l.exitIp.trim() : '';
  const exitIp = IPV4.test(exitIpRaw) || (exitIpRaw.includes(':') && IPV6.test(exitIpRaw)) ? exitIpRaw : '';
  const okServer = !!server && (HOST.test(server) || IPV4.test(server) || (server.includes(':') && IPV6.test(server)));
  // 填了就必须是合法的;没填就是"没配静态 IP"
  if (type === 'none' || !okServer || !Number.isInteger(port) || port < 1 || port > 65535) return { ...EMPTY_LINE };
  return { type, server, port, username, password, exitIp, viaNode: l.viaNode === true };
}

function pickSubs(v: unknown): Sub[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  return v
    .filter((x): x is Sub => !!x && typeof x.id === 'string' && /^[a-z0-9]{1,12}$/.test(x.id) && typeof x.url === 'string' && validSubUrl(x.url.trim()))
    .filter((x) => !seen.has(x.id) && !!seen.add(x.id))
    .slice(0, 10)
    .map((x) => ({
      id: x.id,
      name: (typeof x.name === 'string' && x.name.trim() ? x.name.trim() : subName(x.url)).slice(0, 40),
      url: x.url.trim().slice(0, 2000),
      enabled: x.enabled !== false,
    }));
}

function pickRoutes(v: unknown): { chatgpt: AiRoute; gemini: AiRoute; grok: AiRoute; meta: AiRoute } {
  const r = (v ?? {}) as Record<string, unknown>;
  const one = (k: string, d: AiRoute): AiRoute => (r[k] === 'node' ? 'node' : r[k] === 'static' ? 'static' : d);
  return { chatgpt: one('chatgpt', 'static'), gemini: one('gemini', 'static'), grok: one('grok', 'node'), meta: one('meta', 'node') };
}

function pickRules(v: unknown): UserRule[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  return v
    .map((x) => {
      const o = x as { domain?: unknown; route?: unknown };
      const domain = typeof o?.domain === 'string' ? o.domain.trim().toLowerCase().replace(/^(https?:\/\/)?(\*\.|\+\.)?/, '').replace(/[/:].*$/, '') : '';
      const route = (ROUTES as readonly string[]).includes(String(o?.route)) ? (o.route as RuleRoute2) : 'node';
      return { domain, route } as UserRule;
    })
    .filter((x) => RULE_DOMAIN.test(x.domain) && !seen.has(x.domain) && !!seen.add(x.domain))
    .slice(0, 50);
}
type RuleRoute2 = UserRule['route'];

function pick(o: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of ['autoStart', 'autoConnect', 'keepBackground', 'claudeCodeFix', 'webFollowRegion'] as const) {
    if (typeof o[k] === 'boolean') out[k] = o[k];
  }
  if (o.tun && (TUN_MODES as readonly string[]).includes(o.tun)) out.tun = o.tun;
  if (o.mixedPort !== undefined) out.mixedPort = clampPort(o.mixedPort, DEFAULT_SETTINGS.mixedPort);
  if (o.controllerPort !== undefined) out.controllerPort = clampPort(o.controllerPort, DEFAULT_SETTINGS.controllerPort);
  if (o.line !== undefined) out.line = pickLine(o.line);
  if (Array.isArray(o.subs)) out.subs = pickSubs(o.subs);
  if (typeof o.ownNode === 'string') out.ownNode = o.ownNode.slice(0, 200);
  if (o.aiRoutes && typeof o.aiRoutes === 'object') out.aiRoutes = pickRoutes(o.aiRoutes);
  if (Array.isArray(o.rules)) out.rules = pickRules(o.rules);
  if (typeof o.fpNoise === 'boolean') out.fpNoise = o.fpNoise;
  if (typeof o.fpSeed === 'number' && Number.isInteger(o.fpSeed) && o.fpSeed > 0) out.fpSeed = o.fpSeed;
  if (Array.isArray(o.favNodes)) out.favNodes = o.favNodes.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, 20);
  if (typeof o.autoRegion === 'string') out.autoRegion = /^(HK|TW|JP|SG|US|KR|OTHER)$/.test(o.autoRegion) ? o.autoRegion : '';
  if (typeof o.homeRegion === 'string' && /^(CN|HK|TW|JP|SG|US|KR|GB|DE|NL)$/.test(o.homeRegion)) out.homeRegion = o.homeRegion;
  return out;
}

export function createSettingsStore(dir: string) {
  const file = join(dir, 'settings.json');
  const backupDir = join(dir, 'backups');
  let cache: Settings | null = null;
  // 写入前留一份历史(最近 5 份):误改/误删能翻回去
  const snapshot = (): void => {
    try {
      if (!existsSync(file)) return;
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      copyFileSync(file, join(backupDir, `settings-${stamp}.json`));
      const keep = readdirSync(backupDir).filter((x) => /^settings-.*\.json$/.test(x)).sort();
      for (const old of keep.slice(0, Math.max(0, keep.length - 5))) unlinkSync(join(backupDir, old));
    } catch { /* 备份失败不影响保存 */ }
  };
  return {
    file,
    get(): Settings {
      if (cache) return cache;
      try {
        const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>) : {};
        cache = { ...DEFAULT_SETTINGS, ...pick(raw) };
      } catch {
        cache = { ...DEFAULT_SETTINGS };
      }
      return cache;
    },
    set(patch: Partial<Settings>): Settings {
      snapshot();
      cache = { ...this.get(), ...pick(patch) };
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(cache, null, 2));
      return cache;
    },
    backups: () => {
      try { return readdirSync(backupDir).filter((x) => /^settings-.*\.json$/.test(x)).sort().reverse(); } catch { return []; }
    },
    // 从备份恢复:先把当前状态再留一份,再覆盖读回
    restore(name: string): Settings {
      if (!/^settings-[0-9T:.-]+\.json$/.test(name)) throw new Error('备份名不对');
      const src = join(backupDir, name);
      if (!existsSync(src)) throw new Error('找不到这个备份');
      snapshot();
      copyFileSync(src, file);
      cache = null;
      return this.get();
    },
    reset(): Settings {
      cache = { ...DEFAULT_SETTINGS };
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(cache, null, 2));
      return cache;
    },
  };
}

export const enabledSubs = (s: Settings): Sub[] => s.subs.filter((x) => x.enabled && validSubUrl(x.url));
export type SettingsStore = ReturnType<typeof createSettingsStore>;
export { isoOrNull, bool };

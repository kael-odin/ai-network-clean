// 生成 mihomo 配置:复用 packages/rules/ai-network-script.js 的 main(config) 模板,
// 这样分流规则、DNS 防泄漏、AI 闸门的写法与 Clash 扩展脚本永远是同一份。
//
// 与官方版的差别只在 AIN 这一块:
//   官方:ruleBase = 平台规则服务(带设备令牌),独享 IP 由平台按令牌下发
//   纯净版:ruleBase = null(规则退回模板内置的域名表),proxy = 你自己的静态 IP,front 可选经你的订阅节点
// 不依赖 electron,可以单独跑 node --test
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { AiRoutes, UserRule, Line, Sub } from '../shared/ipc.ts';
import { regionFilter } from './regions.ts';

export interface ConfigInput {
  templatePath: string;       // ai-network-script.js 的路径
  line: Line;                 // 你自己的静态 IP
  homeRegion: string;         // 本地直连的国家代码(国内用户是 CN)
  tun: boolean;               // true = 虚拟网卡接管(需要管理员)
  mixedPort: number;
  extraPorts?: number[];      // 额外监听的本地代理端口(Clash 常用的 7897/7890,空闲时)
  controllerPort: number;
  secret: string;
  ownSubs?: OwnSub[];         // 你的订阅(AI 走静态 IP,其他国外网站走它,国内直连)
  aiRoutes?: AiRoutes;
  userRules?: UserRule[];
  autoRegion?: string;
}

export interface SubDnsInfo {
  nameserverPolicy?: Record<string, string | string[]>;
  hosts?: Record<string, unknown>;
  prefilled?: boolean;
}
export interface OwnSub { id: string; url: string; dns?: SubDnsInfo }

// 组名。conns.ts / anomaly.ts / linefail.ts 都靠这几个名字认线路,改这里就够
export const AI_GROUP = 'AI 专用出口';
export const AI_GATE = 'AI 放行';
export const PROXY_GROUP = '普通代理';
export const FRONT_GROUP = 'AI 前置';
export const AUTO_GROUP = '自动选择';
export const USER_SUB = 'user-sub';
export const subProvider = (id: string) => `${USER_SUB}-${id}`;

// AI 服务(模板里 SERVICES 的三套)。ChatGPT / Gemini 允许用户改走订阅节点,其余固定走静态 IP
const OTHER_AI_SETS = ['chatgpt-core', 'login-microsoft', 'gemini-core', 'pay-google'];
const OTHER_AI_PROCESS = ['ChatGPT.exe', 'ChatGPT'];
const OTHER_AI_DOMAINS = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com', 'chat.com', 'gemini.google.com', 'gemini.google', 'bard.google.com',
  'aistudio.google.com', 'makersuite.google.com', 'alkalimakersuite-pa.clients6.google.com', 'generativelanguage.googleapis.com',
  'login.microsoftonline.com', 'login.live.com', 'signup.live.com', 'account.live.com', 'account.microsoft.com', 'one.google.com', 'payments.google.com', 'pay.google.com'];
const CHATGPT_SETS = ['chatgpt-core', 'login-microsoft'];
const GEMINI_SETS = ['gemini-core', 'pay-google'];
const GEMINI_DOMAINS = ['gemini.google.com', 'gemini.google', 'bard.google.com', 'aistudio.google.com', 'makersuite.google.com', 'alkalimakersuite-pa.clients6.google.com', 'generativelanguage.googleapis.com', 'one.google.com', 'payments.google.com', 'pay.google.com'];

// 用户规则不能碰的网站:Claude(固定走静态 IP)
export const LOCKED_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'clau.de'];
export const lockedDomain = (d: string): boolean => LOCKED_DOMAINS.some((x) => d === x || d.endsWith('.' + x) || x.endsWith('.' + d));

export function isOtherAiRule(rule: string): boolean {
  const [type, payload] = rule.split(',');
  if (type === 'RULE-SET') return OTHER_AI_SETS.some((s) => payload.endsWith('-' + s) || payload === s);
  if (type === 'PROCESS-NAME') return OTHER_AI_PROCESS.includes(payload);
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') return OTHER_AI_DOMAINS.includes(payload);
  return false;
}
export function otherAiService(rule: string): 'chatgpt' | 'gemini' | null {
  if (!isOtherAiRule(rule)) return null;
  const [type, payload] = rule.split(',');
  if (type === 'RULE-SET') return GEMINI_SETS.some((s) => payload.endsWith('-' + s) || payload === s) ? 'gemini' : CHATGPT_SETS.some((s) => payload.endsWith('-' + s) || payload === s) ? 'chatgpt' : null;
  if (type === 'PROCESS-NAME') return 'chatgpt';
  return GEMINI_DOMAINS.includes(payload) ? 'gemini' : 'chatgpt';
}
export const serviceDomains = (s: 'chatgpt' | 'gemini'): string[] => OTHER_AI_DOMAINS.filter((d) => (s === 'gemini') === GEMINI_DOMAINS.includes(d));

// 浏览器的「安全 DNS」(DoH)也要走静态 IP,否则开不开安全 DNS 会看到两个不同地区的解析器
export const DOH_RULES = [
  'DOMAIN,dns.google', 'DOMAIN,dns.google.com', 'DOMAIN,dns64.dns.google',
  'DOMAIN-SUFFIX,cloudflare-dns.com', 'DOMAIN,one.one.one.one',
  'DOMAIN,dns.quad9.net', 'DOMAIN,dns11.quad9.net', 'DOMAIN-SUFFIX,dns.nextdns.io', 'DOMAIN,doh.opendns.com', 'DOMAIN,dns.adguard-dns.com',
  'DOMAIN,doh.pub', 'DOMAIN,dns.alidns.com', 'DOMAIN,doh.360.cn', 'DOMAIN,dns.twnic.tw',
  'IP-CIDR,8.8.8.8/32', 'IP-CIDR,8.8.4.4/32', 'IP-CIDR,1.1.1.1/32', 'IP-CIDR,1.0.0.1/32', 'IP-CIDR,9.9.9.9/32',
];
export const STUN_BLOCK_RULE = 'AND,((NETWORK,UDP),(DST-PORT,3478/5349/19302-19309)),REJECT';
// 订阅里的说明条目(不是节点):「套餐:」「剩余流量:」「到期:」之类
export const INFO_NODE_FILTER = '^\\s*(官网|网址)\\s*[:：]|^[^:：]{0,10}(套餐|剩余|到期|过期|重置|流量)[^:：]{0,8}[:：]';
const TEST_URL = 'https://www.gstatic.com/generate_204';

// 静态 IP 的代理节点(写进 proxies,由模板套上名字和 dialer-proxy)
function lineProxy(l: Line): Record<string, unknown> | null {
  if (l.type === 'none' || !l.server || !l.port) return null;
  return {
    type: l.type,
    server: l.server,
    port: l.port,
    ...(l.username ? { username: l.username } : {}),
    ...(l.password ? { password: l.password } : {}),
    udp: true,
  };
}

function makeAin(o: ConfigInput): string {
  const q = JSON.stringify;
  const own = !!o.ownSubs?.length;
  const p = lineProxy(o.line);
  return [
    'const AIN = {',
    // 没有规则服务:规则用模板内置的域名表(FALLBACK),规则集不下载
    '  ruleBase: null,',
    '  checkDomain: null,',
    // 本地静态 IP 直接写进配置(模板会把它命名为「AI 专用出口 · 静态 IP」)。
    // 没有静态 IP 时给一个占位节点:让模板走「本地节点」分支,而不是去 ruleBase 拉 ip.yaml
    `  proxy: ${p ? q(p) : q({ type: 'socks5', server: '127.0.0.1', port: 9 })},`,
    // split = Ai 走静态 IP,本地直连,其余走你的订阅节点
    `  mode: ${q('split')},`,
    `  homeRegion: ${q(o.homeRegion)},`,
    // front:'auto' = 先经「普通代理」组再到静态 IP(静态 IP 直连不通时用);
    // null = 直连静态 IP;没有静态 IP 时 front 无意义
    `  front: ${p ? (o.line.viaNode && own ? q('auto') : 'null') : 'null'},`,
    '  services: { claude: true, chatgpt: true, gemini: true },',
    '  links: { auth: true, verify: true, pay: true },',
    '};',
  ].join('\n');
}

// 把模板的 AIN 区块换成我们的(做法与 packages/rules/generate.js 的 withAin 一致)
export function scriptWithAin(template: string, ain: string): string {
  const t = template.replace(/\r\n/g, '\n');
  const start = t.indexOf('const AIN = {');
  const end = t.indexOf('\n};', start) + 3;
  if (start < 0 || end < 3) throw new Error('模板里找不到 AIN 区块');
  return ain + t.slice(end);
}

export function baseConfig(o: ConfigInput): Record<string, unknown> {
  return {
    'mixed-port': o.mixedPort,
    ...(o.extraPorts?.length ? { listeners: o.extraPorts.map((port) => ({ name: `compat-${port}`, type: 'mixed', port, listen: '127.0.0.1', udp: true })) } : {}),
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'info',
    'external-controller': `127.0.0.1:${o.controllerPort}`,
    secret: o.secret,
    'unified-delay': true,
    'tcp-concurrent': true,
    'geodata-mode': false,
    'geo-auto-update': false,
    tun: {
      enable: o.tun,
      stack: 'mixed',
      'auto-route': true,
      'auto-detect-interface': true,
      'dns-hijack': ['any:53'],
      'inet6-address': ['fdfe:dcba:9876::1/126'],
      'strict-route': false,
    },
    proxies: [],
    // 订阅由内核直接拉(和 Clash 一样),节点在节点集里
    'proxy-providers': Object.fromEntries((o.ownSubs ?? []).map((sub) => [subProvider(sub.id), {
      type: 'http', url: sub.url, path: `./proxies/${subProvider(sub.id)}.yaml`, interval: 3600,
      'health-check': { enable: true, url: TEST_URL, interval: 300, lazy: false },
    }])),
    'proxy-groups': [],
    rules: [],
  };
}

export function buildConfig(o: ConfigInput): Record<string, unknown> {
  const template = readFileSync(o.templatePath, 'utf8');
  const script = scriptWithAin(template, makeAin(o));
  const context: { module: { exports: { main?: (c: Record<string, unknown>) => Record<string, unknown> } } } = { module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'ai-network-script.js' });
  const main = context.module.exports.main;
  if (typeof main !== 'function') throw new Error('模板没有导出 main');
  const config = main(baseConfig(o));
  const subs = o.ownSubs ?? [];
  const hasLine = o.line.type !== 'none' && !!o.line.server && o.line.port > 0;

  // 「普通代理」组只收配置里写死的节点;我们的节点在节点集里,改成从节点集里自动选最快的
  if (subs.length) {
    const use = subs.map((x) => subProvider(x.id));
    const groups = config['proxy-groups'] as Record<string, unknown>[];
    const i = groups.findIndex((g) => g.name === PROXY_GROUP);
    const auto = { name: AUTO_GROUP, type: 'url-test', use, url: TEST_URL, interval: 300, tolerance: 150, lazy: false };
    const pick = { name: PROXY_GROUP, type: 'select', proxies: [AUTO_GROUP], use };
    if (i >= 0) groups.splice(i, 1, pick, auto); else groups.push(pick, auto);
    // 机场的说明条目不是节点,别让自动选择选中它
    for (const g of groups) if (Array.isArray(g.use) && (g.use as string[]).some((u) => u.startsWith(USER_SUB))) g['exclude-filter'] = INFO_NODE_FILTER;
    Object.assign(auto, regionFilter(o.autoRegion ?? '', INFO_NODE_FILTER));

    // 节点域名的解析:机场自带的 nameserver-policy 合进来(节点域名常常只能用机场的 DoH 解析);
    // 去掉 proxy-server-nameserver(它不走 nameserver-policy,会把节点域名解析成假地址)
    const dns = config.dns as Record<string, unknown>;
    const ours = (dns['nameserver-policy'] ?? {}) as Record<string, unknown>;
    dns['nameserver-policy'] = { ...Object.assign({}, ...subs.map((x) => x.dns?.nameserverPolicy ?? {})), ...ours };
    delete dns['proxy-server-nameserver'];
    delete dns['proxy-server-nameserver-policy'];
    dns['respect-rules'] = false;
    dns.nameserver = relayModeDns(o.homeRegion).map((u) => u + '#DIRECT');
    const subHosts = Object.assign({}, ...subs.map((x) => x.dns?.hosts ?? {})) as Record<string, unknown>;
    if (Object.keys(subHosts).length > 0) config.hosts = { ...subHosts, ...((config.hosts as Record<string, unknown> | undefined) ?? {}) };
  } else {
    // 没有订阅也没有静态 IP 时,普通代理组会是空组:补一个 DIRECT,免得内核填 COMPATIBLE
    const groups = config['proxy-groups'] as Record<string, unknown>[];
    if (!groups.some((g) => g.name === PROXY_GROUP)) groups.push({ name: PROXY_GROUP, type: 'select', proxies: ['DIRECT'] });
  }

  // IPv6 防泄漏:虚拟网卡也接管 IPv6(模板给 Clash 用户的脚本仍是 ipv6:false,桌面版要自己开)
  if (o.tun) config.ipv6 = true;

  // 指向 AI 组的规则都改到闸门;ChatGPT / Gemini 的除外(用户可以让它们走节点,也不该被闸门拦)
  config.rules = (config.rules as string[]).map((r) => isOtherAiRule(r) ? r : r.split(',').map((x, i) => (i > 0 && x === AI_GROUP ? AI_GATE : x)).join(','));
  (config['proxy-groups'] as Record<string, unknown>[]).push({ name: AI_GATE, type: 'select', proxies: ['REJECT', AI_GROUP] });

  // 出口核对:www.cloudflare.com 直接走 AI 组(不经闸门,闸门关着时也能读到出口);Claude 官方状态同理
  // CF 的挑战页会从 challenges.cloudflare.com 的**子域名**加载脚本;如果子域名走了别的出口,
  // Cloudflare 会认为挑战结果来自不同 IP,于是无限挑战(实测:brunhild.challenges.cloudflare.com 被 Match 到了节点)
  const cfChallenge = `DOMAIN-SUFFIX,challenges.cloudflare.com,${hasLine ? AI_GROUP : PROXY_GROUP}`;
  const hasLineRule = hasLine
    ? [`DOMAIN,www.cloudflare.com,${AI_GROUP}`, `DOMAIN,status.claude.com,${AI_GROUP}`, cfChallenge]
    : [cfChallenge];
  (config.rules as string[]).unshift(
    ...hasLineRule,
    STUN_BLOCK_RULE,
    'DOMAIN,api6.ipify.org,REJECT',
    ...DOH_RULES.map((r) => `${r},${hasLine ? AI_GROUP : PROXY_GROUP}${r.startsWith('IP-CIDR') ? ',no-resolve' : ''}`),
  );

  applyRoutes(config, o);

  // 没有静态 IP:AI 域名的规则与 DNS 都改到「普通代理」(AI 走你的节点,不经过静态 IP 那一层)
  if (!hasLine) {
    config.rules = (config.rules as string[]).map((r) => r.split(',').map((x) => (x === AI_GROUP || x === AI_GATE ? PROXY_GROUP : x)).join(','));
    // 占位节点(127.0.0.1:9)不能留在配置里
    config.proxies = (config.proxies as Record<string, unknown>[]).filter((x) => x.name !== 'AI 专用出口 · 静态 IP');
    const groups = config['proxy-groups'] as Record<string, unknown>[];
    const gate = groups.findIndex((g) => g.name === AI_GATE);
    if (gate >= 0) groups.splice(gate, 1);
    const ai = groups.findIndex((g) => g.name === AI_GROUP);
    if (ai >= 0) groups.splice(ai, 1);
    const dns = config.dns as Record<string, unknown>;
    const policy = (dns['nameserver-policy'] ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(policy)) {
      const v = policy[k];
      policy[k] = Array.isArray(v) ? v.map((s) => String(s).replace('#' + AI_GROUP, '#' + PROXY_GROUP)) : String(v).replace('#' + AI_GROUP, '#' + PROXY_GROUP);
    }
  }

  // 兜底解析器:模板默认带 1.1.1.1(国内解析 DoH 域名会卡住),换成国内可用的
  const dns = config.dns as Record<string, unknown>;
  if (o.homeRegion === 'CN' || o.homeRegion === 'HK' || o.homeRegion === 'TW') {
    dns['default-nameserver'] = ['223.5.5.5', '119.29.29.29'];
  }
  const policy = { ...((dns['nameserver-policy'] ?? {}) as Record<string, unknown>) };
  dns['nameserver-policy'] = policy;
  return config;
}

// 分流:ChatGPT / Gemini 选了「你的节点」就把它们的规则改到节点,DNS 也跟着走;
// 用户自己的网站规则放在所有 AI 规则后面(带不偏 Claude)、默认规则前面
function applyRoutes(config: Record<string, unknown>, o: ConfigInput): void {
  const hasLine = o.line.type !== 'none' && !!o.line.server && o.line.port > 0;
  const node = o.ownSubs?.length ? PROXY_GROUP : 'DIRECT';
  const aiTarget = hasLine ? AI_GROUP : node;
  let rules = config.rules as string[];
  const lastAi = rules.reduce((n, r, i) => (r.split(',').some((x) => x === AI_GROUP || x === AI_GATE) ? i : n), -1);
  const moved = (['chatgpt', 'gemini'] as const).filter((s) => o.aiRoutes?.[s] === 'node');
  if (moved.length) {
    rules = rules.map((r) => {
      const s = otherAiService(r);
      return s && moved.includes(s) ? r.split(',').map((x, i) => (i > 0 && (x === AI_GROUP || x === AI_GATE) ? node : x)).join(',') : r;
    });
  }
  const target = { static: aiTarget, node, direct: 'DIRECT' } as const;
  // Grok、Meta AI:选了静态 IP 才加规则,不选就和普通网站一样走节点
  const extra = ([['grok', ['grok.com', 'x.ai']], ['meta', ['meta.ai']]] as const)
    .filter(([k]) => o.aiRoutes?.[k] === 'static')
    .flatMap(([, ds]) => ds.map((d) => `DOMAIN-SUFFIX,${d},${aiTarget}`));
  const mine = (o.userRules ?? []).filter((r) => !lockedDomain(r.domain)).map((r) => `DOMAIN-SUFFIX,${r.domain},${target[r.route]}`);
  if (mine.length || extra.length) rules = [...rules.slice(0, lastAi + 1), ...extra, ...mine, ...rules.slice(lastAi + 1)];
  config.rules = rules;
  if (moved.length) {
    const dns = config.dns as Record<string, unknown>;
    const keys = moved.flatMap(serviceDomains).map((d) => '+.' + d).join(',');
    const dnsTarget = node === 'DIRECT' ? 'DIRECT' : PROXY_GROUP;
    dns['nameserver-policy'] = { [keys]: [`https://1.1.1.1/dns-query#${dnsTarget}`], ...((dns['nameserver-policy'] ?? {}) as Record<string, unknown>) };
  }
}

// 其他网站的 DNS:系统 DNS + 本地能用的 DoH 一起问,内核取最先回来的。
// 国内直连问 1.1.1.1 基本都超时(实测每次多等好几秒),按本地地区换成对应的一组
export function relayModeDns(region: string): string[] {
  const cn = region === 'CN' || region === 'HK' || region === 'TW';
  return cn
    ? ['system', 'https://223.5.5.5/dns-query', 'https://doh.pub/dns-query']
    : ['system', 'https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
}

// mihomo 能直接读 JSON(JSON 是合法的 YAML)
export function configText(c: Record<string, unknown>): string {
  return JSON.stringify(c, null, 2);
}

// 静态 IP 节点缓存文件按线路指纹分开:换了一条静态 IP 不会沿用上一条的缓存
export function lineTag(l: Line): string {
  return createHash('sha256').update(`${l.type}|${l.server}|${l.port}|${l.username}`).digest('hex').slice(0, 12);
}

export type { AiRoutes, UserRule, Sub };

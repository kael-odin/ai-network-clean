// 内置 mihomo 内核:找二进制、准备工作目录(地理数据库)、写配置、启动/停止、经控制接口查状态
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { buildConfig, configText, subProvider, AI_GROUP, FRONT_GROUP, PROXY_GROUP, AUTO_GROUP, type OwnSub } from './config.ts';
import { createLogFile, type LogFile } from './logfile.ts';
import type { AiRoutes, UserRule, Line, SubSummary, NodeInfo, NodeList } from '../shared/ipc.ts';
import { regionOf } from './regions.ts';

const GEO_FILES = ['Country.mmdb', 'geoip.dat', 'geosite.dat', 'ASN.mmdb'];

export interface MihomoOptions {
  workDir: string;      // 配置、日志、规则缓存
  templatePath: string;
  resourcesDir: string; // 打包后放 mihomo.exe 和地理数据库的目录
  packaged: boolean;
}

export interface GroupStatus {
  now: string;         // 当前生效的节点名
  lineUp: boolean;
  members: string[];
}

export interface StartInput {
  line: Line;
  homeRegion: string;
  tun: boolean;
  mixedPort: number;
  extraPorts?: number[];
  controllerPort: number;
  ownSubs?: (OwnSub & { name: string })[];
  aiRoutes?: AiRoutes;
  userRules?: UserRule[];
  autoRegion?: string;
}

// 内核二进制先定哪来:打包版只认安装目录里的 resources/mihomo.exe,不读环境变量。
// 程序是按最高权限运行的,而安装目录和环境变量普通权限的程序都能改——让环境变量能指到
// 任意可执行文件,等于把「下次开机以管理员身份运行任意程序」的入口开出去,不需要 UAC
export function findBinary(o: MihomoOptions): string {
  const override = o.packaged ? null : (process.env.AIN_MIHOMO_BIN || null);
  const candidates = [override, join(o.resourcesDir, 'mihomo.exe')]
    .filter((p): p is string => !!p);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 mihomo 内核(' + candidates.join(' / ') + ')');
  return hit;
}

// 打包版启动前按仓库里登记的 SHA-256 校验(和 scripts/fetch-resources.mjs 的 MIHOMO_SHA256 是同一个值)。
// 没登记时只警告不拦:不能因为维护者还没填就让所有用户用不了,但日志里要看得见
export function verifyBinary(bin: string, expected: string | null): { ok: boolean; sha: string; detail: string } {
  const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  if (!expected) return { ok: true, sha, detail: '没有登记校验值,跳过校验(见 scripts/fetch-resources.mjs 的 MIHOMO_SHA256)' };
  return sha === expected
    ? { ok: true, sha, detail: `SHA-256 校验通过(${sha.slice(0, 12)}…)` }
    : { ok: false, sha, detail: `内核文件的 SHA-256 对不上(实际 ${sha}),已拒绝启动。重新下载:node apps/desktop/scripts/fetch-resources.mjs --force` };
}

// 地理数据库:打包后从 resources 复制
export function prepareWorkDir(o: MihomoOptions): void {
  mkdirSync(o.workDir, { recursive: true });
  for (const f of GEO_FILES) {
    const dst = join(o.workDir, f);
    if (existsSync(dst)) continue;
    const src = join(o.resourcesDir, f);
    if (existsSync(src)) copyFileSync(src, dst);
  }
}

export class Mihomo {
  #o: MihomoOptions;
  #child: ChildProcess | null = null;
  #secret = '';
  #subs: { id: string; name: string }[] = [];
  #controllerPort = 0;
  #mixedPort = 0;
  #log: string;
  #logFile: LogFile;
  #logBytes = 0;
  #tail: string[] = [];
  hasLine = false;
  // 由调用方在启动前设置(打包时写入的期望哈希);null = 没有登记
  static expectedSha: string | null = null;
  // 最近一次「AI 出口」的拨号结果。select 组没有测试 URL,mihomo 的 /group/:name/delay 对它不生效,
  // 所以自己测组里那个节点(/proxies/<名字>/delay),结果缓存 90 秒
  #lineProbe: { at: number; delay: number } | null = null;
  onExit: ((code: number | null, lastLines: string) => void) | null = null;
  // 每一行内核日志(异常连接记录用)
  onLine: ((line: string) => void) | null = null;

  constructor(o: MihomoOptions) {
    this.#o = o;
    this.#log = join(o.workDir, 'mihomo.log');
    this.#logFile = createLogFile(this.#log);
  }

  get running(): boolean { return this.#child !== null; }
  get pid(): number | null { return this.#child?.pid ?? null; }
  get mixedPort(): number { return this.#mixedPort; }
  get recentLog(): string { return this.#tail.join('\n'); }
  get logSize(): number { return this.#logBytes; }
  // TUN 没起来(被别的 VPN 占着地址):必须换成本地代理模式重启,否则所有出站都会绑到错网卡
  get tunFailed(): boolean { return this.#tail.some((l) => l.includes('Start TUN listening error')); }

  async start(input: StartInput): Promise<void> {
    if (this.#child) throw new Error('内核已在运行');
    prepareWorkDir(this.#o);
    const bin = findBinary(this.#o);
    // 打包版:内核要按最高权限运行,启动前按登记的哈希核对一次(开发版用 AIN_MIHOMO_BIN 指定,不校验)
    if (this.#o.packaged) {
      const v = verifyBinary(bin, Mihomo.expectedSha);
      if (!v.ok) throw new Error(v.detail);
    }
    this.#secret = randomBytes(16).toString('hex');
    this.#controllerPort = input.controllerPort;
    this.#mixedPort = input.mixedPort;
    this.hasLine = input.line.type !== 'none';
    const config = buildConfig({ ...input, templatePath: this.#o.templatePath, secret: this.#secret });
    const configPath = join(this.#o.workDir, 'config.json');
    writeFileSync(configPath, configText(config));
    // 用户订阅每次连接都重新拉:内核按文件新旧决定要不要重拉,机场偶尔返回一次「到期」提示节点会被缓存一小时
    for (const sub of input.ownSubs ?? []) if (!sub.dns?.prefilled) rmSync(join(this.#o.workDir, 'proxies', `${subProvider(sub.id)}.yaml`), { force: true });
    this.#subs = (input.ownSubs ?? []).map((x) => ({ id: x.id, name: x.name }));
    try { renameSync(this.#log, this.#log.replace(/\.log$/, '.prev.log')); } catch { /* 第一次启动 */ }
    this.#logFile.close();
    writeFileSync(this.#log, `[${new Date().toISOString()}] 启动 ${bin}\n`);
    this.#logFile = createLogFile(this.#log);
    this.#tail = [];
    const child = spawn(bin, ['-d', this.#o.workDir, '-f', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child = child;
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8');
      // 异步写盘 + 8MB 轮转:跑一整天也不会把主进程卡在同步 I/O 上,日志也不会无限长
      this.#logFile.write(s);
      this.#logBytes = this.#logFile.size;
      this.#tail = this.#tail.concat(s.split('\n').filter((l) => l)).slice(-120);
      if (this.onLine) for (const l of s.split('\n')) if (l.includes(' --> ')) this.onLine(l);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      this.#child = null;
      this.onExit?.(code, this.#tail.join('\n'));
    });
    // 等控制接口能应答,最多 15 秒
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!this.#child) throw new Error('内核启动后退出:\n' + this.#tail.join('\n'));
      try {
        const r = await this.#api('/version');
        if (r.ok) { await this.setGate(false).catch(() => {}); return; }
      } catch { /* 还没起来 */ }
      await new Promise((ok) => setTimeout(ok, 300));
    }
    await this.stop();
    throw new Error('内核 15 秒内没有就绪:\n' + this.#tail.join('\n'));
  }

  kill(): void {
    const child = this.#child;
    this.#child = null;
    try { child?.kill(); } catch { /* 已经没了 */ }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    await new Promise<void>((ok) => {
      child.once('exit', () => ok());
      child.kill();
      setTimeout(ok, 3000);
    });
  }

  async #api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.#controllerPort}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.#secret}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5000),
    });
  }

  // 「AI 专用出口」组现在选中的节点名
  async #aiNow(): Promise<string> {
    const r = await this.#api('/proxies/' + encodeURIComponent(AI_GROUP));
    if (!r.ok) return '';
    return ((await r.json()) as { now?: string }).now ?? '';
  }

  // AI 专用出口组现在选中的节点,以及它最近一次健康检查是否通过
  async groupStatus(): Promise<GroupStatus> {
    if (!this.hasLine) {
      // 没有静态 IP:AI 走你的节点,没有「线路可用」这回事
      const { effective } = await this.#selection().catch(() => ({ effective: null }));
      return { now: effective ?? '', lineUp: true, members: [] };
    }
    const r = await this.#api('/proxies/' + encodeURIComponent(AI_GROUP));
    if (!r.ok) throw new Error('读取代理组失败:HTTP ' + r.status);
    const j = (await r.json()) as { now?: string; all?: string[] };
    const now = j.now ?? '';
    let lineUp = !!now && !now.includes('阻断');
    if (lineUp) {
      type Hist = { delay: number }[];
      if (this.#lineProbe && Date.now() - this.#lineProbe.at < 90_000) {
        lineUp = this.#lineProbe.delay > 0;
      } else {
        const p = await this.#api('/proxies/' + encodeURIComponent(now)).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { alive?: boolean; history?: Hist } | null;
        const last = p?.history?.at(-1);
        lineUp = !!p && p.alive !== false && !!last && last.delay > 0;
      }
    }
    return { now, lineUp, members: j.all ?? [] };
  }

  // 让内核立刻对静态 IP 做一次健康检查,返回延迟(<=0 表示不通)
  async checkGroup(): Promise<number> {
    if (!this.hasLine) return -1;
    const now = await this.#aiNow().catch(() => '');
    if (!now) { this.#lineProbe = { at: Date.now(), delay: -1 }; return -1; }
    const url = '/proxies/' + encodeURIComponent(now) + '/delay?url=' + encodeURIComponent('https://www.gstatic.com/generate_204') + '&timeout=10000';
    const r = await this.#api(url).catch(() => null);
    let delay = -1;
    if (r?.ok) {
      const j = (await r.json().catch(() => null)) as { delay?: number } | null;
      delay = typeof j?.delay === 'number' && j.delay > 0 ? j.delay : -1;
    }
    this.#lineProbe = { at: Date.now(), delay };
    return delay;
  }

  async #userNodes(): Promise<{ nodes: NodeInfo[]; updatedAt: string | null }> {
    type Hist = { delay: number }[];
    type Member = { name: string; type?: string; alive?: boolean; udp?: boolean; history?: Hist; extra?: Record<string, { history?: Hist }> };
    const provs = await Promise.all(this.#subs.map((sub) => this.#api('/providers/proxies/' + encodeURIComponent(subProvider(sub.id))).then((x) => (x.ok ? x.json() : null)).catch(() => null) as Promise<{ proxies?: Member[]; updatedAt?: string } | null>));
    const nodes = provs.flatMap((prov, i) => (prov?.proxies ?? []).map((m) => {
      const lasts = [m.history?.at(-1), ...Object.values(m.extra ?? {}).map((e) => e.history?.at(-1))].filter((h): h is { delay: number } => !!h);
      const delay = lasts.length === 0 ? null : Math.max(...lasts.map((h) => h.delay));
      return { name: m.name, type: m.type ?? '', delay, alive: delay === null ? m.alive !== false : delay > 0, udp: m.udp === true, provider: this.#subs[i].id, region: regionOf(m.name) };
    }));
    const updatedAt = provs.map((p) => p?.updatedAt ?? null).filter((x): x is string => !!x).sort().at(-1) ?? null;
    return { nodes, updatedAt };
  }

  async #selection(): Promise<{ selected: string; effective: string | null }> {
    const g = await this.#api('/proxies/' + encodeURIComponent(PROXY_GROUP)).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { now?: string } | null;
    const selected = g?.now ?? AUTO_GROUP;
    if (selected !== AUTO_GROUP) return { selected, effective: selected };
    const a = await this.#api('/proxies/' + encodeURIComponent(AUTO_GROUP)).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { now?: string } | null;
    return { selected, effective: a?.now ?? null };
  }

  async userSubStatus(): Promise<SubSummary> {
    const { nodes } = await this.#userNodes();
    const { isPlaceholderNode } = await import('./sub.ts');
    const placeholders = nodes.filter((m) => isPlaceholderNode(m.name)).map((m) => m.name);
    const real = nodes.filter((m) => !isPlaceholderNode(m.name));
    const usable = real.filter((m) => (m.delay ?? 0) > 0).length;
    const { effective } = await this.#selection();
    return { total: real.length, placeholders, usable, now: effective };
  }

  async nodeList(): Promise<NodeList> {
    const [{ nodes, updatedAt }, sel] = await Promise.all([this.#userNodes(), this.#selection()]);
    return { nodes, updatedAt, ...sel, auto: AUTO_GROUP };
  }

  async checkUserSub(): Promise<void> {
    await this.#api('/group/' + encodeURIComponent(AUTO_GROUP) + '/delay?url=' + encodeURIComponent('https://www.gstatic.com/generate_204') + '&timeout=8000').catch(() => {});
  }

  async refreshUserSub(): Promise<void> {
    await Promise.all(this.#subs.map((sub) => this.#api('/providers/proxies/' + encodeURIComponent(subProvider(sub.id)), { method: 'PUT' }).catch(() => {})));
    await this.checkUserSub();
  }

  // 去静态 IP 那一跳经哪个节点(「AI 前置」是 fallback 组,由客户端逐个试、固定住真正能连上的那个)
  async setFront(name: string): Promise<void> {
    await this.#api('/proxies/' + encodeURIComponent(FRONT_GROUP), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
  }

  // 让内核重新读一遍配置(一键修复用)
  async reload(configPath: string): Promise<void> {
    const r = await this.#api('/configs?force=true', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: configPath }) });
    if (!r.ok) throw new Error('重载配置失败:HTTP ' + r.status);
  }

  // 开关 AI 流量的闸门;没有静态 IP 时没有闸门,直接成功
  async setGate(open: boolean): Promise<void> {
    if (!this.hasLine) return;
    const r = await this.#api('/proxies/' + encodeURIComponent('AI 放行'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: open ? AI_GROUP : 'REJECT' }) });
    if (!r.ok) throw new Error('切换 AI 闸门失败:HTTP ' + r.status);
  }

  async connections(): Promise<RawConnLike[]> {
    const r = await this.#api('/connections');
    if (!r.ok) throw new Error('读取连接失败:HTTP ' + r.status);
    return ((await r.json()) as { connections?: RawConnLike[] | null }).connections ?? [];
  }

  async selectNode(name: string): Promise<void> {
    const r = await this.#api('/proxies/' + encodeURIComponent(PROXY_GROUP), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name || AUTO_GROUP }) });
    if (!r.ok) throw new Error('切换节点失败:HTTP ' + r.status);
  }
}

export interface RawConnLike {
  id: string;
  metadata: { host?: string; destinationIP?: string; destinationPort?: string; process?: string; network?: string };
  upload: number; download: number; start: string; chains: string[]; rule: string; rulePayload: string;
}

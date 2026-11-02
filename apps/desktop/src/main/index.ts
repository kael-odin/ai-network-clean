// 主进程:窗口与托盘、连接（静态 IP + 订阅）、AI 闸门与防护检测、Claude 相关检测、诊断、设置
// 纯净版:没有账号、没有设备激活、没有计费、没有遥测、没有自动更新
import { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, nativeImage, clipboard, screen, Notification, dialog, powerMonitor } from 'electron';
import { createConnLog } from './connlog.ts';
import { createStats, describeStats } from './stats.ts';
import { decideGate } from './gate.ts';
import { claudeSeenToday, isDesktop, listClaude, parseClaudeStatus, pickClaude, STATUS_URL } from './claude.ts';
import { createConnTracker } from './conns.ts';
import { createLineFail, reasonText } from './linefail.ts';
import { regionOf } from './regions.ts';
import { runSplitTest, TARGETS } from './splittest.ts';
import { createAnomalyLog, isAbnormalEvent } from './anomaly.ts';
import { createSysDns } from './sysdns.ts';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { Mihomo } from './mihomo.ts';
import { AI_GROUP, PROXY_GROUP } from './config.ts';
import { createSettingsStore, enabledSubs } from './settings.ts';
import { checkRoutes, diagnose } from './diagnose.ts';
import { clearStaleSysProxy, createSysProxy } from './sysproxy.ts';
import { fetchSubDns } from './subinfo.ts';
import { checkClaudeCode, fixClaudeCode, resumeClaudeCodeFix, setBackupDir, suspendClaudeCodeFix, undoClaudeCode } from './claudecode.ts';
import { checkIp, checkIpv6, checkWebrtc, evaluateDnsLocal, hasPublicIpv6 } from './protect.ts';
import { buildEnvReport } from './claudeenv.ts';
import { cleanClaude, scanClaude } from './claudeclean.ts';
import { launchClaudeCode, launchClaudeDesktop, openClaudeWeb } from './launch.ts';
import { testLine } from './linetest.ts';
import { createIdentities } from './identities.ts';
import { isPlaceholderNode, describeSub } from './sub.ts';
import type {
  AiCheck, Anomaly, AppState, ClaudeApps, ClaudeSeen, ClaudeStatus, CcReport, ConnState, DiagReport,
  Line, LogEntry, NodeList, ProtectItem, ProtectReport, Settings, SplitRow,
} from '../shared/ipc.ts';

// 数据目录用固定名字(%APPDATA%in-clean),不跟着 productName 走,免得和别的版本撞
app.setName('ain-clean');
// 测试/多开:用独立数据目录。只给开发版用:打包版按最高权限运行,环境和数据目录被普通权限的程序改得动,
// 让它能改数据目录,等于让普通程序决定以管理员身份读哪份设置
if (!app.isPackaged && process.env.AIN_USER_DATA) app.setPath('userData', process.env.AIN_USER_DATA);
const userData = () => app.getPath('userData');
const HIDDEN_START = process.argv.includes('--hidden');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayWin: BrowserWindow | null = null;
let quitting = false;
let shuttingDown = false;

const settingsStore = createSettingsStore(userData());
const connLog = createConnLog(userData());
const sysDns = createSysDns(userData());
const sysProxy = createSysProxy(userData());
const anomalies = createAnomalyLog(userData());
const stats = createStats();
const lineFail = createLineFail();
const conns = createConnTracker();
// 身份隔离:真实位置是 ~/.claude、~/.claude.json、%APPDATA%\Claude;槽在用户数据目录里
const identities = createIdentities({
  home: homedir(),
  appdata: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  dataDir: userData(),
  isClaudeRunning: async () => {
    const list = await listClaude().catch(() => []);
    return { desktop: list.some((a) => isDesktopPath(a.path)), cli: list.filter((a) => !isDesktopPath(a.path)).length };
  },
  killClaude: async () => {
    const run = (args: string[]) => new Promise<number>((ok) => execFile('taskkill', args, { windowsHide: true }, () => ok(1)));
    await run(['/IM', 'claude.exe', '/F', '/T']).catch(() => 0);
    await run(['/IM', 'Claude.exe', '/F', '/T']).catch(() => 0);
    return { killed: 1 };
  },
});
const mihomo = new Mihomo({
  workDir: join(userData(), 'mihomo'),
  templatePath: join(__dirname, 'ai-network-script.js'),
  // 打包后是 <app>/resources;开发时用 apps/desktop/resources
  resourcesDir: app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources'),
  packaged: app.isPackaged,
});
setBackupDir(userData());
// 内核哈希:构建时写进 dist/main/kernel.sha256;读不到就不校验(开发版、或旧构建)
try {
  const sha = readFileSync(join(__dirname, 'kernel.sha256'), 'utf8').trim();
  if (/^[0-9a-f]{64}$/.test(sha)) Mihomo.expectedSha = sha;
} catch { /* 没有这个文件就不拦 */ }

const IDLE_CONN: ConnState = {
  status: 'disconnected', mode: 'proxy', lineUp: null, exitIp: null, expectedIp: null,
  node: null, front: null, error: null, warning: null, checkedAt: null, since: null,
  recovered: null, downSince: null, downReason: null,
};

const state: AppState = {
  step: 'setup',
  conn: { ...IDLE_CONN },
  settings: settingsStore.get(),
  protect: null,
  protectChecking: false,
  aiCheck: null,
  claudeSeen: null,
  claudeStatus: null,
  claudeApps: null,
  claudeCode: null,
  claudeRun: null,
  env: null,
  clean: null,
  nodes: null,
  diag: null,
  log: [],
  abnormal: [],
  anomalies: [],
  connections: [],
  closedConns: [],
  quickAt: null,
  version: app.getVersion(),
  admin: false,
  packaged: app.isPackaged,
  tunAvailable: false,
  externalTun: null,
  stats,
};

let lastOtherTun: string | null = null;
const lineReason = (): string | null => {
  const c = lineFail.reason();
  return c ? reasonText(c, state.settings.line.viaNode) : null;
};

// 状态推送:以前每次 log()/检测/轮询都同步把整个 AppState(含日志、连接列表)序列化发给两个窗口,
// 托盘窗口隐藏时也照发。改成合并到 80ms 一次、隐藏的窗口不发,打开时自己拉一次最新状态
let pushTimer: NodeJS.Timeout | null = null;
function sendState(): void {
  stats.logBytes = mihomo.logSize;
  state.stats = stats;
  state.conn.downReason = state.conn.lineUp === false ? lineReason() : null;
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
  if (trayWin && !trayWin.isDestroyed() && trayWin.isVisible()) trayWin.webContents.send('state', state);
  updateTray();
}
function push(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; sendState(); }, 80);
}
// 窗口刚打开/托盘刚弹出时立刻给一份,不能等节流
function pushNow(): void {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  sendState();
}

function log(kind: string, text: string): void {
  const e = connLog.add(kind, text);
  state.log = connLog.recent();
  if (isAbnormalEvent(e)) state.abnormal = [...state.abnormal, e].slice(-100);
  push();
}

function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: iconPath() });
    n.on('click', () => showWindow());
    n.show();
  } catch { /* 弹不出来不影响别的 */ }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- 权限与冲突 ----------
async function isAdmin(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const { execFile } = await import('node:child_process');
  return new Promise((ok) => execFile('net', ['session'], { windowsHide: true }, (err) => ok(!err)));
}

// 别的软件(Clash Verge、其他 VPN)开着时我们的 TUN 起不来,而且流量会先经它:这时退回本地代理模式并提醒
const PROXY_PROCESSES = /^(clash-verge|verge-mihomo|verge-mihomo-alpha|clash|Clash for Windows|clash-win64|clashn|mihomo|sing-box|v2rayn|v2ray|xray|netch|nekobox|nekoray|hiddify|flclash|Surge)$/i;
const PROXY_ADAPTER = /Mihomo|Clash|Meta Tunnel|sing-box|Surge|Netch|v2ray|Xray/i;
const VPN_ADAPTER = /\bTUN\b|TAP-|WireGuard|Tailscale|ZeroTier|VPN|Hamachi|Oray|Wintun/i;

// 独立检测:有没有别的虚拟网卡占着默认路由(它就是本机「直连」的真实出口)
async function detectExternalTun(): Promise<{ name: string; description: string } | null> {
  if (process.platform !== 'win32') return null;
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string>((ok) => execFile('powershell', ['-NoProfile', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $d = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).ifIndex; Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.ifIndex -eq $d } | ForEach-Object { $_.Name + '|' + $_.InterfaceDescription }"],
    { windowsHide: true, timeout: 10_000 }, (_e, stdout) => ok(String(stdout ?? ''))));
  const [name, desc] = out.trim().split('|');
  if (!name) return null;
  // 只有「隧道类」网卡才算:物理网卡占默认路由是正常的,不能报成外部 TUN
  const TUNNEL = /Meta|Mihomo|Clash|TUN|wintun|Wintun|TAP-|WireGuard|Tailscale|ZeroTier|Wireguard|OpenVPN|Hamachi|VPN/i;
  if (!TUNNEL.test(`${name} ${desc ?? ''}`)) return null;
  return { name, description: desc ?? '' };
}

async function otherTunAdapter(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const { execFile } = await import('node:child_process');
  const run = (file: string, args: string[]) => new Promise<string>((ok) => execFile(file, args, { windowsHide: true }, (_e, stdout) => ok(String(stdout ?? ''))));
  const [adapters, procs] = await Promise.all([
    run('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $d = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0','0.0.0.0/1','128.0.0.0/1' } | ForEach-Object { $_.ifIndex }); Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object { $_.Name + '|' + $_.InterfaceDescription + '|' + ($d -contains $_.ifIndex) }"]),
    run('tasklist', ['/FO', 'CSV', '/NH']),
  ]);
  const adapter = adapters.split(/\r?\n/).map((l) => l.trim().split('|')).find(([name, desc, route]) => {
    const text = `${name ?? ''}|${desc ?? ''}`;
    return !!name && (PROXY_ADAPTER.test(text) || (VPN_ADAPTER.test(text) && /^true$/i.test(route ?? '')));
  });
  if (adapter) return adapter[0];
  const names = procs.split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/)?.[1] ?? '').replace(/\.exe$/i, '')).filter(Boolean);
  for (const name of names.filter((n) => PROXY_PROCESSES.test(n))) {
    if (/^mihomo$/i.test(name)) {
      // 我们自己的内核也叫 mihomo.exe(上次没退干净的):按路径排除
      const paths = await run('powershell', ['-NoProfile', '-Command', 'Get-Process mihomo -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }']);
      const ours = app.getPath('exe').replace(/\\[^\\]+$/, '').toLowerCase();
      if (paths.split(/\r?\n/).map((p) => p.trim().toLowerCase()).filter(Boolean).every((p) => p.startsWith(ours))) continue;
    }
    return name + '.exe';
  }
  return null;
}

// 连着时还有没有别的代理软件在跑、系统代理是不是指向别的程序
async function proxyConflict(): Promise<ProtectItem> {
  if (process.platform !== 'win32') return { state: 'ok', detail: '' };
  const { execFile } = await import('node:child_process');
  const run = (file: string, args: string[]) => new Promise<string>((ok) => execFile(file, args, { windowsHide: true }, (_e, stdout) => ok(String(stdout ?? ''))));
  const [procs, inet] = await Promise.all([run('tasklist', ['/FO', 'CSV', '/NH']), run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])]);
  const ours = mihomo.pid;
  const names = [...new Set(procs.split(/\r?\n/).map((l) => l.match(/^"([^"]+)","(\d+)"/)).filter((m): m is RegExpMatchArray => !!m)
    .filter((m) => Number(m[2]) !== ours).map((m) => m[1].replace(/\.exe$/i, '')).filter((n) => PROXY_PROCESSES.test(n) && !/^mihomo$/i.test(n)))];
  const proxyOn = /ProxyEnable\s+REG_DWORD\s+0x1\b/.test(inet);
  const server = inet.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1] ?? '';
  const ourPorts = [state.settings.mixedPort, ...(mihomo.running ? [7897, 7890] : [])];
  const sysOther = proxyOn && server && !ourPorts.some((p) => server.includes(':' + p)) ? server : null;
  if (!names.length && !sysOther) return { state: 'ok', detail: '没有别的代理或 VPN 在和客户端抢流量' };
  const parts = [names.length ? `检测到 ${names.join('、')} 正在运行` : '', sysOther ? `系统代理指向 ${sysOther}` : ''].filter(Boolean);
  return { state: 'fail', detail: `${parts.join(',')}:浏览器等程序的流量可能先经过它,不走你的静态 IP。退出它再重新连接,客户端才能完整接管` };
}

// ---------- 连接 ----------
let connecting: Promise<void> | null = null;
let connectGen = 0;
let restarting = false;
let recovering = false;
class Cancelled extends Error {}
const connectTimings: string[] = [];
let connectT0 = 0;
const mark = (step: string) => { connectTimings.push(`${step} ${((Date.now() - connectT0) / 1000).toFixed(1)}s`); };

const hasLine = (s: Settings = state.settings): boolean => s.line.type !== 'none' && !!s.line.server && s.line.port > 0;
const isReady = (s: Settings = state.settings): boolean => hasLine(s) || enabledSubs(s).length > 0;

// 系统代理只有还指着我们时才还原:断开时已经还原过、或者用户自己又改过,都不要去动它
async function restoreOwnSystemProxy(): Promise<void> {
  const ours = await sysProxy.pointsTo(state.settings.mixedPort).catch(() => false);
  if (ours) await sysProxy.restore().catch(() => {});
}

function connect(retry = true, keepDns = false): Promise<void> {
  connecting ??= connectOnce(retry, keepDns).finally(() => { connecting = null; });
  return connecting;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

async function networkReady(): Promise<boolean> {
  const { connect: tcpConnect } = await import('node:net');
  const tryOne = (host: string, port: number) => new Promise<boolean>((ok) => {
    const s = tcpConnect({ host, port, timeout: 2500 });
    const done = (v: boolean) => { s.destroy(); ok(v); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
  const all = [tryOne('223.5.5.5', 443), tryOne('119.29.29.29', 53), tryOne('1.1.1.1', 443)];
  return new Promise((ok) => {
    let left = all.length;
    for (const p of all) void p.then((v) => { if (v) ok(true); else if (--left === 0) ok(false); });
  });
}

async function connectOnce(retry = true, keepDns = false): Promise<void> {
  const gen = connectGen;
  const cancelled = () => gen !== connectGen;
  const s = state.settings;
  if (retry) { connectTimings.length = 0; connectT0 = Date.now(); }
  lineFail.reset();
  unknownStreak.clear();

  if (!isReady(s)) {
    state.step = 'setup';
    state.conn = { ...IDLE_CONN, status: 'failed', mode: state.conn.mode, error: '还没有可用的线路:在「设置」里填一条静态 IP,或添加一个节点订阅' };
    push();
    return;
  }
  if (mihomo.running) return;

  if (!keepDns && !(await networkReady())) {
    state.conn = { ...IDLE_CONN, status: 'failed', mode: state.conn.mode, error: '电脑还没有连上网络(Wi-Fi 或网线)。连上网以后再点「开启连接」;开机时客户端会自己等网络连好再连接。' };
    log('连接失败', '电脑还没有连上网络');
    push();
    return;
  }

  const subs = enabledSubs(s);
  const subDnsP = subs.length ? Promise.all(subs.map((x) => fetchSubDns(x.url, join(userData(), 'mihomo'), x.id))) : Promise.resolve([]);
  const staleP = clearStaleSysProxy().catch(() => null);
  const other = await otherTunAdapter();
  state.externalTun = await detectExternalTun().catch(() => null);
  mark('检测其他代理软件');
  lastOtherTun = other;
  const wantTun = s.tun === 'off' ? false : s.tun === 'on' ? state.admin && !other : state.admin && !other;
  let tun = wantTun;
  const tunNote = state.externalTun
    ? `另一个虚拟网卡「${state.externalTun.name}」正在接管全局流量:本客户端的「直连」会经它出去,静态 IP 能不能连上由它决定`
    : null;
  // 上面几次读系统状态都要几百毫秒,期间用户可能已经点了「断开」:取消时不能再改系统代理、不能再起内核
  if (cancelled()) throw new Cancelled();
  const warning = other
    ? `${tunNote ? tunNote + '。' : ''}检测到「${other}」在运行:已改用本地代理模式,要完整接管请退出它再重新连接。`
    : !state.admin ? `没有管理员权限:本地代理模式,只接管浏览器(系统代理已指到 127.0.0.1:${s.mixedPort}),桌面程序接管不了。` : null;
  state.conn = { ...IDLE_CONN, status: 'starting', mode: tun ? 'tun' : 'proxy', expectedIp: s.line.exitIp || null, warning };
  state.protect = null;
  state.aiCheck = null;
  stats.connects++;
  if (retry) log('连接', `开始连接(${tun ? '虚拟网卡' : '本地代理'}模式${other ? `,检测到 ${other}` : ''})`);
  push();

  if (!tun && sysDns.pending()) await sysDns.restore().catch(() => {});
  if (tun) {
    // 上一次是本地代理模式、系统代理还指着我们:切 TUN 前先还原,免得浏览器绕一圈
    await sysProxy.restore().catch(() => {});
  } else {
    await sysProxy.take(s.mixedPort).then(() => log('接管系统代理', `系统代理已指到 127.0.0.1:${s.mixedPort}(断开时还原)`), () => {});
    // take 之后才被取消:把刚改的系统代理还原,别让浏览器指向一个不会再起来的内核
    if (cancelled()) { await restoreOwnSystemProxy(); throw new Cancelled(); }
  }
  const stale = await staleP;
  mark('清残留系统代理');
  if (stale) { state.conn.recovered = stale; push(); }

  // Clash 常用端口空着就接着听,记着旧系统代理的程序不用重启
  const CLASH_PORTS = [7897, 7890];
  const extraPorts = (await Promise.all(CLASH_PORTS.map(async (p) => ((await portFree(p)) ? p : 0)))).filter(Boolean);
  if (extraPorts.length) log('兼容端口', `接管 Clash 留下的本地代理端口 ${extraPorts.join('、')},记着它的程序不用重启`);

  const input = {
    line: s.line,
    homeRegion: s.homeRegion,
    tun,
    mixedPort: s.mixedPort,
    extraPorts,
    controllerPort: s.controllerPort,
    aiRoutes: s.aiRoutes,
    userRules: s.rules,
    autoRegion: s.autoRegion,
  };

  // 这边继续等订阅节点、测速,期间断开:同样要把系统代理还原,否则浏览器指向没人听的端口
  if (cancelled()) { await restoreOwnSystemProxy(); throw new Cancelled(); }
  try {
    const subDns = subs.length ? await subDnsP : [];
    if (subs.length) mark('客户端拉订阅取 DNS');
    const extra = { ownSubs: subs.map((x, i) => ({ id: x.id, name: x.name, url: x.url, dns: subDns[i] })) };
    await mihomo.start({ ...input, ...extra });
    mark('内核启动');
    if (cancelled()) throw new Cancelled();
    if (tun) {
      await new Promise((ok) => setTimeout(ok, 1500));
      if (cancelled()) throw new Cancelled();
      if (mihomo.tunFailed) {
        restarting = true;
        await mihomo.stop();
        restarting = false;
        tun = false;
        state.conn.mode = 'proxy';
        state.conn.warning = '虚拟网卡没能启动(多半是别的 VPN 或 Clash 还在运行),已改用本地代理模式。退出它们后断开再连接即可完整接管。';
        push();
        await mihomo.start({ ...input, tun: false, ...extra });
      } else {
        try {
          const names = await sysDns.apply({ ipv6: hasPublicIpv6(networkInterfaces()) });
          if (names.length) log('接管 DNS', `已把 ${names.join('、')} 的 DNS 临时指到客户端,断开时恢复`);
          if (names.length) sysDns.watchdog(process.pid);
        } catch (e) { log('接管 DNS', '没能改物理网卡的 DNS:' + errorMessage(e)); }
        mark('接管物理网卡 DNS');
      }
    }

    // 订阅节点
    if (subs.length) {
      let sub = await mihomo.userSubStatus();
      for (let i = 0; i < 40 && mihomo.running && sub.total === 0 && sub.placeholders.length === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        sub = await mihomo.userSubStatus();
      }
      mark('内核拉到订阅');
      const bad = describeSub(sub);
      if (bad) throw new Error(bad);
      let tested = false;
      void mihomo.checkUserSub().then(() => { tested = true; });
      for (let i = 0; i < 70 && mihomo.running && sub.usable === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 300));
        sub = await mihomo.userSubStatus();
        if (tested && i > 30) break;
      }
      mark('节点测速有可用节点');
      const pinned = s.ownNode;
      if (pinned) {
        const list = await mihomo.nodeList().catch(() => null);
        if (list?.nodes.some((n) => n.name === pinned)) await mihomo.selectNode(pinned).catch(() => {});
        else applySettings(settingsStore.set({ ownNode: '' }));
        sub = await mihomo.userSubStatus();
      }
      state.conn.node = sub.now;
      // 连上就把节点列表读出来:界面不用再点一次「测速」才看得到
      state.nodes = await mihomo.nodeList().catch(() => null);
      if (sub.usable === 0) state.conn.warning = (state.conn.warning ? state.conn.warning + '\n' : '') + `你的 ${sub.total} 个节点都没有测通,AI 请求会失败:检查你的节点是否能用,或换一条订阅。`;
      push();
    }

    // 静态 IP
    if (hasLine(s)) {
      state.conn.lineUp = null;
      for (let i = 0; i < 6 && mihomo.running; i++) {
        const delay = await mihomo.checkGroup();
        if (delay > 0) break;
        await new Promise((ok) => setTimeout(ok, 800));
      }
      mark('静态 IP 健康检查');
      let g = await mihomo.groupStatus().catch(() => null);
      if (g?.lineUp !== true && s.line.viaNode && subs.length) g = { ...(g ?? { now: '', members: [] }), lineUp: await findWorkingFront() };
      if (g?.lineUp === false) state.conn.warning = (state.conn.warning ? state.conn.warning + '\n' : '') + `连不上静态 IP:AI 流量会被拦住(不会改走节点)。${lineReason() ?? ''}`;
      state.conn.lineUp = g?.lineUp ?? null;
      state.conn.front = state.conn.front ?? null;
    }

    if (!mihomo.running) throw new Error('网络组件启动后又退出了,请再连接一次;还不行就到「日志」页复制诊断报告');
    state.conn.status = 'connected';
    state.conn.since = new Date().toISOString();
    log('已连接', `${state.conn.mode === 'tun' ? '虚拟网卡' : '本地代理'}模式${state.conn.node ? `,节点「${state.conn.node}」` : ''}${hasLine(s) ? ' · AI 走静态 IP' : ' · AI 走节点'}`);
    push();
    void runChecks();
    connectedAt = Date.now();
    if (state.settings.claudeCodeFix && resumeClaudeCodeFix(s.mixedPort)) log('Claude Code', '连上了,把 Claude Code 的代理重新指到客户端(断开时已临时撤销)');
    void readClaudeStatus();
    void checkClaudeApps();
    startPolling();
  } catch (e) {
    restarting = true;
    await mihomo.stop();
    restarting = false;
    if (e instanceof Cancelled || cancelled()) {
      if (!keepDns) await sysDns.restore().catch(() => {});
      await restoreOwnSystemProxy();
      return;
    }
    if (retry && /订阅里没有节点/.test(errorMessage(e))) {
      mark('订阅没拉到,3 秒后重连');
      await new Promise((ok) => setTimeout(ok, 3000));
      if (state.conn.status !== 'starting') return;
      return connectOnce(false, keepDns);
    }
    if (!keepDns) await sysDns.restore().catch(() => {});
    // 连接失败:系统代理也要还原,否则浏览器一直指向一个没有程序在听的端口
    await restoreOwnSystemProxy();
    state.conn = { ...state.conn, status: 'failed', error: errorMessage(e) };
    stats.connectFailures++;
    log('连接失败', errorMessage(e).split('\n')[0].slice(0, 200));
    if (!win?.isVisible()) notify('没能连上', errorMessage(e).split('\n')[0].slice(0, 120));
    push();
  }
}

async function disconnect(): Promise<void> {
  if (state.conn.status === 'connected' || state.conn.status === 'starting') log('断开', '断开连接');
  connectGen++;
  stopPolling();
  suspendClaudeCodeFix();
  state.conn = { ...state.conn, status: 'disconnected' };
  await mihomo.stop();
  await sysDns.restore().catch(() => {});
  await sysProxy.restore().catch(() => {});
  state.conn = { ...IDLE_CONN, mode: state.conn.mode, expectedIp: state.settings.line.exitIp || null };
  state.protect = null;
  state.aiCheck = null;
  state.claudeStatus = null;
  state.claudeApps = null;
  state.nodes = null;
  conns.clear();
  state.connections = [];
  state.closedConns = [];
  push();
}

// 内核意外退出:物理网卡的 DNS 先不改回(它还指着已经不在的内核,AI 网站连不上而不是直连),
// 立刻自动重连最多 3 次;都不行才改回 DNS,停在「连接失败」
async function recover(code: number | null, tail: string): Promise<void> {
  recovering = true;
  try {
    stats.autoRecovers++;
    log('意外断开', `网络组件意外退出(代码 ${code}),正在自动重连;重连期间 AI 网站暂时打不开`);
    notify('网络组件意外退出', '正在自动重新连接，期间 AI 网站暂时打不开。');
    void sysDns.flush().catch(() => {});
    for (let i = 1; i <= 3; i++) {
      state.conn = { ...state.conn, status: 'starting', lineUp: null, warning: `网络组件意外退出，正在自动重连（第 ${i} 次）…` };
      push();
      await connect(true, true).catch(() => {});
      if (state.conn.status === 'connected') { stats.reconnected++; log('恢复', `自动重连成功(第 ${i} 次)`); notify('已重新连接', '网络组件已恢复，AI 网站可以继续使用。'); return; }
      if (state.conn.status === 'disconnected') return;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    await sysDns.restore().catch(() => {});
    await restoreOwnSystemProxy();
    state.conn = { ...state.conn, status: 'failed', lineUp: null, error: `内核退出(代码 ${code}),自动重连没有成功\n${tail}` };
    log('意外断开', '自动重连 3 次都没成功,已改回网络设置;请重新连接');
    notify('AI 网站已禁止访问', '网络组件意外退出，自动重连没有成功。打开客户端重新连接。');
    push();
  } finally { recovering = false; }
}

mihomo.onExit = (code, tail) => {
  stopPolling();
  if (state.conn.status === 'disconnected' || state.conn.status === 'starting' || restarting || quitting || recovering || shuttingDown) return;
  if (code === 0x40010004) return; // 关机/注销时系统结束进程
  void recover(code, tail);
};

// ---------- 检测 ----------
const checkSession = () => session.fromPartition('check');
// 环境一致性:最近一次出口核对读到的国家(cloudflare trace 的 loc=)
let exitCountry: string | null = null;

// 出口核对:经内核的本地端口读 Cloudflare 的 trace,看到的 IP 应该是你的静态 IP
async function check(): Promise<void> {
  if (!mihomo.running) return;
  try {
    const s = checkSession();
    await s.setProxy({ proxyRules: `http=127.0.0.1:${mihomo.mixedPort};https=127.0.0.1:${mihomo.mixedPort}`, proxyBypassRules: '<-loopback>' });
    const r = await s.fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    const text = await r.text();
    const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim() ?? null;
    const loc = text.match(/^loc=([A-Z]{2})$/m)?.[1] ?? null;
    exitCountry = loc ?? exitCountry;
    state.conn.exitIp = ip;
    const expected = state.settings.line.exitIp || null;
    state.conn.expectedIp = expected;
    state.conn.error = ip && expected && ip !== expected ? `出口 IP 是 ${ip},不是你的静态 IP ${expected}` : null;
  } catch (e) {
    state.conn.exitIp = null;
    state.conn.error = state.conn.lineUp === false ? `静态 IP 不可用(${AI_GROUP} 已阻断)${lineReason() ? ':' + lineReason() : ''}` : '验证出口失败:' + errorMessage(e);
  }
  state.conn.checkedAt = new Date().toISOString();
  const ip = state.conn.exitIp;
  const expected = state.settings.line.exitIp || null;
  log('出口验证', ip ? `出口 IP ${ip}${expected ? (ip === expected ? '(是你的静态 IP)' : `(不是你的静态 IP ${expected})`) : ''}` : `没有拿到出口 IP:${state.conn.error ?? ''}`);
  push();
}

// 5 分钟一次的出口核对:只看出口 IP 对不对;不对就马上跑完整检测(会拦住 AI)
let checking: Promise<void> | null = null;
async function lightCheck(): Promise<void> {
  if (state.conn.status !== 'connected' || checking) return;
  stats.lightChecks++;
  let changed = false;
  checking = (async () => {
    const prev = { exitIp: state.conn.exitIp, error: state.conn.error };
    await check();
    const ip = state.conn.exitIp;
    if (!ip && prev.exitIp && state.conn.lineUp !== false) { state.conn.exitIp = prev.exitIp; state.conn.error = prev.error; push(); }
    changed = !!ip && ip !== (state.settings.line.exitIp || undefined) && !!state.settings.line.exitIp;
  })().finally(() => { checking = null; });
  await checking;
  if (changed) void runChecks();
}

// 整套检测:出口 → DNS(本机机制)→ IPv6 → WebRTC;都通过才打开 AI 闸门
const unknownStreak = new Map<string, number>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let quickRetried = false;
let lastFullAt = 0;

function runChecks(): Promise<void> {
  if (!mihomo.running || state.conn.status !== 'connected') return Promise.resolve();
  checking ??= (async () => {
    lastFullAt = Date.now();
    stats.fullChecks++;
    if (state.aiCheck?.state !== 'done') state.aiCheck = { state: 'waiting', reason: null, sites: [] };
    push();
    await check();
    await runProtect();
    if (state.conn.status !== 'connected') return;
    void runClaudeCode();
    const p = state.protect;
    const ip = state.conn.exitIp;
    const expected = state.settings.line.exitIp || null;
    const items: [string, 'ok' | 'fail' | 'unknown'][] = [
      ['静态 IP 出口', !hasLine() ? 'ok' : !ip ? 'unknown' : !expected ? 'ok' : ip === expected ? 'ok' : 'fail'],
      ['DNS 防泄露', (p?.dns.state ?? 'unknown') as 'ok' | 'fail' | 'unknown'],
      ['IPv6 防泄露', (p?.ipv6.state ?? 'unknown') as 'ok' | 'fail' | 'unknown'],
      ['WebRTC 防泄露', (p?.webrtc.state ?? 'unknown') as 'ok' | 'fail' | 'unknown'],
    ];
    const why: Record<string, string> = {
      '静态 IP 出口': state.conn.error ?? (ip ? `出口是 ${ip}` : '没拿到出口 IP'),
      'DNS 防泄露': p?.dns.detail ?? '',
      'IPv6 防泄露': p?.ipv6.detail ?? '',
      'WebRTC 防泄露': p?.webrtc.detail ?? '',
    };
    const reasons = items.filter(([, st]) => st !== 'ok').map(([name]) => why[name] ? `${name}:${why[name]}` : '').filter(Boolean).join(';');
    // 本地代理模式:浏览器的 WebRTC 和 IPv6 不经过我们,拦不住也测不准。这两项只提醒不拦
    const soft = state.conn.mode !== 'tun' ? ['IPv6 防泄露', 'WebRTC 防泄露'] : [];
    const wasOpen = state.aiCheck?.state === 'done';
    const g = decideGate(items, soft, wasOpen, unknownStreak);
    const notOk = g.block;
    const warn = g.warn;
    if (g.tolerated.length) log('防护复查', `${g.tolerated.join('、')}(${reasons}),先不拦 AI,下一轮还是这样再拦`);
    if (Date.now() - leakSeenAt < 60_000) notOk.push(leakText || '有 AI 连接没走静态 IP');
    if (notOk.length && hasLine()) {
      await mihomo.setGate(false).catch(() => {});
      stats.gateBlocks++;
      state.aiCheck = { state: 'blocked', reason: notOk.join('、'), sites: [] };
      log('拦截 AI', `${notOk.join('、')},AI 流量已拦截(其他网站照常)${reasons ? `。原因:${reasons}` : ''}`);
      if (wasOpen) notify('AI 流量已拦截', `${notOk.join('、')}，为保护网络身份已拦截 AI 流量。`);
      if (notOk.every((x) => x.endsWith('未确认')) && !retryTimer && !quickRetried) {
        quickRetried = true;
        retryTimer = setTimeout(() => { retryTimer = null; void runChecks(); }, 10_000);
      }
      push();
      return;
    }
    if (hasLine()) { await mihomo.setGate(true).catch(() => {}); stats.gateOpens++; }
    quickRetried = false;
    state.aiCheck = { state: 'done', reason: null, sites: [], warn: warn.length ? warn.join('、') : null };
    if (!wasOpen) log('放行 AI', warn.length ? `静态 IP 出口、DNS 防护通过,AI 流量已放行;本地代理模式下${warn.join('、')}(只提醒)` : '防护都通过,AI 流量已放行');
    push();
    // 真实出口核对:按浏览器的网络路径读 claude.ai 的 trace(只读 ip= 那一行,不打开网站)
    const real = await realExitCheck();
    if (state.conn.status !== 'connected' || !real.length) return;
    const mine = state.settings.line.exitIp || null;
    const wrong = mine ? real.filter((x) => x.ip && x.ip !== mine) : [];
    state.aiCheck = { ...state.aiCheck!, sites: real.map((x) => ({ name: x.name, ip: x.ip, ok: x.ip && mine ? x.ip === mine : undefined })) };
    if (wrong.length) {
      const text = wrong.map((x) => `${x.name} 看到的是 ${x.ip}`).join('、');
      if (state.conn.mode === 'tun' && hasLine()) {
        await mihomo.setGate(false).catch(() => {});
        state.aiCheck = { state: 'blocked', reason: `真实出口不是静态 IP(${text})`, sites: state.aiCheck.sites };
        log('拦截 AI', `真实出口核对不一致:${text},AI 流量已拦截`);
        notify('AI 流量已拦截', `AI 网站看到的出口不是你的静态 IP(${text})。`);
      } else {
        state.aiCheck = { ...state.aiCheck, warn: [state.aiCheck.warn, `浏览器的出口不是静态 IP(${text}),多半走的是别的代理`].filter(Boolean).join(';') };
        log('出口核对', `本地代理模式下浏览器的出口不是静态 IP:${text}(只提醒)`);
      }
    } else log('出口核对', real.map((x) => `${x.name} ${x.ip ? '看到 ' + x.ip : '读不到'}`).join(' · '));
    state.claudeSeen = claudeSeenToday(connLog.all());
    state.env = buildEnvReport(exitCountry);
    if (state.conn.mode === 'proxy' && state.claudeRun?.desktop) {
      const tip = 'Claude 桌面版正在运行:本地代理模式下它的子进程可能绕过系统代理直连。要保证全链路,请用「Claude」页从客户端启动,或改用虚拟网卡(TUN)模式';
      state.aiCheck = { ...(state.aiCheck ?? { state: 'done', reason: null, sites: [] }), warn: [state.aiCheck?.warn, tip].filter(Boolean).join(';') };
      log('全链路提示', tip);
    }
    push();
  })().finally(() => { checking = null; });
  return checking;
}

// 按浏览器的网络路径读 AI 网站的 trace:TUN 模式直连,本地代理模式按系统代理。读不到的隔 5 秒再读,最多 3 次
async function realExitCheck(): Promise<{ name: string; ip: string | null }[]> {
  const s = state.conn.mode === 'tun' ? session.defaultSession : session.fromPartition('system-net');
  if (state.conn.mode !== 'tun') await s.setProxy({ mode: 'system' }).catch(() => {});
  const read = async (host: string): Promise<string | null> => {
    try {
      const text = await (await s.fetch(`https://${host}/cdn-cgi/trace`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' })).text();
      return text.match(/^ip=(.+)$/m)?.[1]?.trim() ?? null;
    } catch { return null; }
  };
  return Promise.all([['claude.ai', 'Claude']].map(async ([host, name]) => {
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise((ok) => setTimeout(ok, 5000));
      if (state.conn.status !== 'connected') break;
      const ip = await read(host);
      if (ip) return { name, ip };
    }
    return { name, ip: null };
  }));
}

let protecting: Promise<void> | null = null;
function runProtect(): Promise<void> {
  if (!mihomo.running || state.conn.status !== 'connected') return Promise.resolve();
  protecting ??= (async () => {
    state.protectChecking = true;
    push();
    const tun = state.conn.mode === 'tun';
    const dnsCheck = tun ? await sysDns.verify().catch(() => ({ reverted: [] as string[], added: [] as string[] })) : { reverted: [], added: [] };
    if (dnsCheck.added.length) log('接管 DNS', `新连上的 ${dnsCheck.added.join('、')} 的 DNS 也临时指到客户端,断开时恢复`);
    if (dnsCheck.reverted.length) stats.dnsReverts += dnsCheck.reverted.length;
    if (dnsCheck.reverted.length) log('接管 DNS', `${dnsCheck.reverted.join('、')} 的 DNS 被别的软件改回去了,已重新指到客户端`);
    const [routeStep, ipv6Item, webrtcItem, conflictItem] = await Promise.all([
      tun ? checkRoutes(hasPublicIpv6(networkInterfaces())) : Promise.resolve(null),
      checkIpv6({ hasIpv6: hasPublicIpv6(networkInterfaces()), fetch: (u, init) => session.defaultSession.fetch(u, init), tun }),
      checkWebrtc(state.settings.line.exitIp || null, tun, hasPublicIpv6(networkInterfaces())),
      proxyConflict().catch((): ProtectItem => ({ state: 'unknown', detail: '没查出来' })),
    ]);
    const routeOk = routeStep?.state === 'ok';
    const needLocal = tun && !dnsCheck.reverted.length;
    const dnsConfirmed = needLocal ? await sysDns.confirm().catch(() => false) : false;
    const dnsItem = evaluateDnsLocal({ tun, dnsConfirmed, routeOk, dnsReverted: dnsCheck.reverted });
    const routeItem: ProtectItem = !routeStep
      ? { state: 'fail', detail: '本地代理模式没有断网保护:客户端只接管浏览器,网络组件退出时浏览器会直连。用管理员身份运行(虚拟网卡模式)才有' }
      : routeStep.state === 'ok' ? { state: 'ok', detail: routeStep.detail + ';网络组件意外退出时会先拦住 AI 再自动重连' } : { state: 'fail', detail: routeStep.detail };
    const report: ProtectReport = {
      at: new Date().toISOString(),
      ip: checkIp(state.conn.exitIp, state.settings.line.exitIp || null),
      dns: dnsItem, ipv6: ipv6Item, webrtc: webrtcItem, route: routeItem, conflict: conflictItem,
    };
    state.protect = report;
    if (dnsCheck.reverted.length) setTimeout(() => void runChecks(), 15_000);
    state.protectChecking = false;
    push();
  })().finally(() => { protecting = null; state.protectChecking = false; });
  return protecting;
}

// 每 30 秒的本地快检:不看网络,只看网卡 DNS 有没有被改回、路由还在不在
async function quickLocal(): Promise<void> {
  if (state.conn.status !== 'connected' || checking || protecting) return;
  stats.quickChecks++;
  if (state.conn.mode === 'tun') {
    const v = await sysDns.verify().catch(() => null);
    if (v?.added.length) log('接管 DNS', `新连上的 ${v.added.join('、')} 的 DNS 也临时指到客户端,断开时恢复`);
    if (v?.reverted.length) {
      stats.dnsReverts += v.reverted.length;
      log('接管 DNS', `${v.reverted.join('、')} 的 DNS 被别的软件改回去了,已重新指到客户端,马上重新检测`);
      await mihomo.setGate(false).catch(() => {});
      state.aiCheck = { state: 'blocked', reason: 'DNS 被别的软件改回去了,正在重新检测', sites: state.aiCheck?.sites ?? [] };
      push();
      void runChecks();
      return;
    }
    const r = await checkRoutes(hasPublicIpv6(networkInterfaces())).catch(() => null);
    if (r && r.state !== 'ok' && state.protect?.route?.state === 'ok') { void runChecks(); return; }
  }
  if (state.conn.mode === 'proxy') {
    const ok = await sysProxy.pointsTo(state.settings.mixedPort).catch(() => true);
    if (!ok) {
      log('接管系统代理', '系统代理被别的软件改走了,已重新指到客户端');
      await sysProxy.take(state.settings.mixedPort).catch(() => {});
    }
  }
  state.quickAt = new Date().toISOString();
  push();
}

// ---------- 轮询与漂移监控 ----------
let poll: NodeJS.Timeout | null = null;
let driftTimer: NodeJS.Timeout | null = null;
let quickTimer: NodeJS.Timeout | null = null;
let lightTimer: NodeJS.Timeout | null = null;
let statusTimer: NodeJS.Timeout | null = null;
let netTimer: NodeJS.Timeout | null = null;
let subTimer: NodeJS.Timeout | null = null;
let netSig = '';

function netSignature(): string {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/Meta|Mihomo|Clash|TUN|wintun|Loopback/i.test(name))
    .flatMap(([name, list]) => (list ?? []).filter((x) => !x.internal).map((x) => name + '=' + x.address))
    .sort().join('|');
}

function startDriftWatch(): void {
  stopDriftWatch();
  netSig = netSignature();
  lastFullAt = Date.now();
  driftTimer = setInterval(() => {
    if (state.conn.status !== 'connected') return;
    if (state.aiCheck?.state === 'blocked' || Date.now() - lastFullAt >= 30 * 60_000) void runChecks();
  }, 60_000);
  lightTimer = setInterval(() => void lightCheck(), 5 * 60_000);
  quickTimer = setInterval(() => void quickLocal(), 30_000);
  statusTimer = setInterval(() => void readClaudeStatus(), 5 * 60_000);
  // 订阅定时重拉:机场节点/到期状态会变,连着一整天时不能只靠启动那一次(思路来自 clash-verge-rev 的定时任务)
  subTimer = setInterval(() => {
    if (state.conn.status !== 'connected' || enabledSubs(state.settings).length === 0) return;
    stats.subRefreshes++;
    void mihomo.refreshUserSub().then(() => { log('节点', '已定时重拉订阅'); void syncNode(); }).catch(() => {});
  }, 6 * 3_600_000);
  netTimer = setInterval(() => {
    const sig = netSignature();
    if (sig === netSig) return;
    netSig = sig;
    if (state.conn.status !== 'connected') return;
    stats.netChanges++;
    log('网络变化', '检测到网络变化(换网或网卡变动),重新检测防护');
    setTimeout(() => void runChecks(), 3000);
  }, 15_000);
}
function stopDriftWatch(): void {
  for (const t of [driftTimer, quickTimer, lightTimer, statusTimer, netTimer, subTimer]) if (t) clearInterval(t);
  driftTimer = quickTimer = lightTimer = statusTimer = netTimer = subTimer = null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  quickRetried = false;
}

function startPolling(): void {
  stopPolling();
  startDriftWatch();
  poll = setInterval(async () => {
    if (!mihomo.running) { stopPolling(); return; }
    try {
      let g = await mihomo.groupStatus();
      if (hasLine() && !g.lineUp && state.conn.lineUp) { await mihomo.checkGroup(); g = await mihomo.groupStatus(); }
      const node = enabledSubs(state.settings).length ? (await mihomo.userSubStatus()).now : null;
      if (g.lineUp !== state.conn.lineUp && state.conn.lineUp !== null) {
        if (!g.lineUp) {
          log('禁止访问', '静态 IP 连不上，已禁止访问 AI 网站(不改走其他线路)');
          notify('AI 网站已禁止访问', '静态 IP 暂时连不上，为保持网络身份不变，AI 流量已暂停。恢复后会自动接上。');
        } else {
          log('恢复', '静态 IP 恢复，AI 网站可以访问了');
          notify('已恢复', '静态 IP 恢复了，AI 网站可以正常访问。');
          void runChecks();
        }
      }
      if (g.lineUp !== state.conn.lineUp || node !== state.conn.node) { state.conn.lineUp = g.lineUp; state.conn.node = node; push(); }
      if (hasLine() && g.lineUp === false) {
        state.conn.downSince ||= new Date().toISOString();
        if (state.settings.line.viaNode && enabledSubs(state.settings).length) void findWorkingFront();
      } else { state.conn.downSince = null; }
      // 连接记录(每 2 秒一次单独读,这里只同步节点)
      const list = await mihomo.connections().catch(() => null);
      if (list) {
        conns.update(list);
        const l = conns.list();
        if (l.active.length !== state.connections.length || l.closed.length !== state.closedConns.length) {
          state.connections = l.active;
          state.closedConns = l.closed;
          push();
        }
      }
    } catch { /* 下次再看 */ }
  }, 20_000);
}
function stopPolling(): void { if (poll) { clearInterval(poll); poll = null; } stopDriftWatch(); }

// 静态 IP 连不上时逐个换前置节点试,哪个通了就固定用它
let frontSearching: Promise<boolean> | null = null;
function findWorkingFront(): Promise<boolean> {
  frontSearching ??= (async () => {
    try {
      const list = await mihomo.nodeList().catch(() => null);
      const mine = list?.effective ?? null;
      const region = state.settings.autoRegion;
      const inRegion = (name: string) => !region || regionOf(name) === region;
      const candidates = (list?.nodes ?? []).filter((n) => (n.delay ?? 0) > 0 && !isPlaceholderNode(n.name))
        .sort((a, b) => Number(b.name === mine) - Number(a.name === mine) || Number(inRegion(b.name)) - Number(inRegion(a.name)) || (a.delay ?? 0) - (b.delay ?? 0))
        .map((n) => n.name).slice(0, 8);
      for (const name of candidates) {
        if (!mihomo.running) return false;
        await mihomo.setFront(name);
        await mihomo.checkGroup();
        const g = await mihomo.groupStatus().catch(() => null);
        if (g?.lineUp) {
          state.conn.lineUp = true;
          state.conn.front = name;
          state.conn.downSince = null;
          log('换节点', `经「${name}」连上了静态 IP`);
          push();
          return true;
        }
      }
      await mihomo.setFront(PROXY_GROUP);
      state.conn.front = null;
      push();
      return false;
    } finally { frontSearching = null; }
  })();
  return frontSearching;
}

// ---------- Claude ----------
async function readClaudeStatus(): Promise<void> {
  if (state.conn.status !== 'connected') return;
  const s = state.conn.mode === 'tun' ? session.defaultSession : session.fromPartition('system-net');
  const json = await s.fetch(STATUS_URL, { signal: AbortSignal.timeout(10_000), cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  const st = json ? parseClaudeStatus(json) : null;
  if (!st) return;
  const was = state.claudeStatus?.level ?? 'ok';
  if (st.level !== was) log('Claude 官方状态', st.level === 'ok' ? 'Claude 官方已恢复正常' : `Claude 官方${st.level === 'maintenance' ? '在维护' : '正在故障'}:${st.text}(不是你的网络问题)`);
  state.claudeStatus = st;
  push();
}

let connectedAt = 0;
async function checkClaudeApps(): Promise<void> {
  const apps: ClaudeApps = pickClaude(await listClaude().catch(() => []), connectedAt);
  if (state.conn.status !== 'connected') return;
  state.claudeApps = apps.desktop || apps.cli ? apps : null;
  state.claudeRun = { desktop: !!apps.desktop, cli: apps.cli };
  if (state.claudeApps) log('Claude 已在运行', [apps.desktop ? 'Claude 桌面版' : '', apps.cli ? `${apps.cli} 个 Claude Code` : ''].filter(Boolean).join('、') + '在连接前就开着了,提示空闲时重开');
  push();
}

async function runClaudeCode(): Promise<void> {
  state.claudeCode = await checkClaudeCode({ ourPid: mihomo.pid, ourPort: state.settings.mixedPort, tun: state.conn.mode === 'tun', connected: state.conn.status === 'connected' }).catch(() => state.claudeCode);
  push();
}

// ---------- 泄漏监控(每次请求都把关) ----------
// 内核每输出一行连接日志就喂给异常记录。以前这里没接:mihomo.onLine 一直是 null、anomalies.feed 从没被调用过,
// 「AI 连接没走静态 IP 就立刻关闸」这条防线实际没生效,anomalies.jsonl 永远是空的
mihomo.onLine = (line) => {
  if (state.conn.status !== 'connected') return;
  anomalies.feed(line, state.aiCheck?.state === 'blocked' ? (state.aiCheck.reason ?? '') : null);
};

let leakSeenAt = 0;
let leakText = '';
anomalies.onLeak((a) => {
  if (!hasLine()) return;
  leakSeenAt = Date.now();
  leakText = `${a.proc} 访问 ${a.host} 没走静态 IP(${a.reason})`;
  stats.leaks++;
  if (state.conn.status !== 'connected' || state.aiCheck?.state === 'blocked') return;
  stats.gateBlocks++;
  void mihomo.setGate(false).catch(() => {});
  state.aiCheck = { state: 'blocked', reason: leakText, sites: state.aiCheck?.sites ?? [] };
  log('拦截 AI', `${leakText},AI 流量已拦截(其他网站照常)`);
  notify('AI 流量已拦截', `${leakText}。为保护网络身份已拦截 AI 流量,一分钟后自动复查。`);
  push();
  setTimeout(() => void runChecks(), 61_000);
});
anomalies.onFlush((list) => {
  if (list.length) state.anomalies = anomalies.recent();
  push();
});
setInterval(() => {
  anomalies.flush();
  const r = anomalies.recent();
  if (r.length !== state.anomalies.length || r[0]?.count !== state.anomalies[0]?.count) { state.anomalies = r; push(); }
}, 10_000);

// ---------- 设置与自启 ----------
function applySettings(s: Settings): void {
  state.settings = s;
  state.step = isReady(s) ? 'ready' : 'setup';
  void syncAutoStart();
}

// 客户端要管理员权限(TUN),Windows 开机时会跳过注册表启动项里要提权的程序,所以用「计划任务 + 最高权限」登录时启动(不弹授权)
const TASK = 'AI Network Clean';
async function syncAutoStart(): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const on = state.settings.autoStart;
  if (!state.admin) { app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }); return; }
  app.setLoginItemSettings({ openAtLogin: false });
  const { execFile } = await import('node:child_process');
  const run = (args: string[]) => new Promise<boolean>((ok) => execFile('schtasks', args, { windowsHide: true }, (e) => ok(!e)));
  const user = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
  if (on) {
    const done = await run(['/Create', '/TN', TASK, '/TR', `"${app.getPath('exe')}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/RU', user, '/IT', '/F']);
    if (!done) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  } else await run(['/Delete', '/TN', TASK, '/F']);
}

// ---------- 窗口与托盘 ----------
const iconPath = () => join(__dirname, '../../build/icon.png');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1040, height: 700, minWidth: 940, minHeight: 620,
    title: 'AI Network Clean',
    icon: iconPath(),
    backgroundColor: '#f2f5fa',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#eaf2fb', symbolColor: '#374151', height: 40 },
    show: !HIDDEN_START,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('session-end', onSessionEnd);
  // 界面只该是本地的 index.html:不让它被导航到任何外部页面(否则远程页面会拿到 preload 的全部能力)
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (e) => {
    if (quitting) return;
    if (!state.settings.keepBackground) { quitting = true; app.quit(); return; }
    e.preventDefault();
    win?.hide();
  });
  win.on('closed', () => { win = null; });
}

function onSessionEnd(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  quitting = true;
  stopPolling();
  suspendClaudeCodeFix();
  mihomo.kill();
  sysDns.restoreDetached();
  void sysProxy.restore();
  app.exit(0);
}

function showWindow(page?: string): void {
  trayWin?.hide();
  if (!win) createWindow();
  win!.show();
  win!.focus();
  if (page) win!.webContents.send('nav', page);
  pushNow();
}

function createTrayWindow(): void {
  trayWin = new BrowserWindow({
    width: 360, height: 560, show: false, frame: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#f2f5fa',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  trayWin.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray' });
  trayWin.webContents.on('will-navigate', (e) => e.preventDefault());
  trayWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trayWin.on('blur', () => { trayWin?.hide(); trayHiddenAt = Date.now(); });
  trayWin.on('session-end', onSessionEnd);
  trayWin.on('closed', () => { trayWin = null; });
}

let trayHiddenAt = 0;
function toggleTrayWindow(): void {
  if (!tray) return;
  if (!trayWin) createTrayWindow();
  if (trayWin!.isVisible()) { trayWin!.hide(); return; }
  if (Date.now() - trayHiddenAt < 300) return;
  const b = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const [w, h] = trayWin!.getSize();
  let x = Math.round(b.x + b.width / 2 - w / 2);
  let y = b.y > area.y + area.height / 2 ? b.y - h - 8 : b.y + b.height + 8;
  x = Math.min(Math.max(x, area.x + 8), area.x + area.width - w - 8);
  y = Math.min(Math.max(y, area.y + 8), area.y + area.height - h - 8);
  trayWin!.setPosition(x, y);
  trayWin!.show();
  trayWin!.focus();
  pushNow();
}

function createTray(): void {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', toggleTrayWindow);
  tray.on('double-click', () => showWindow());
  createTrayWindow();
  updateTray();
}

// 托盘菜单只在「连接状态 + 静态 IP 可用性」变化时重建:每次推送都 build 一遍菜单是白费
let trayMenuKey = '';
function updateTray(): void {
  if (!tray) return;
  const c = state.conn.status;
  const connected = c === 'connected';
  tray.setToolTip(`AI Network Clean · ${connected ? (state.conn.lineUp === false ? '静态 IP 不可用' : '已连接') : c === 'starting' ? '连接中' : '未连接'}`);
  const key = `${c}|${state.conn.lineUp}|${isReady()}`;
  if (key === trayMenuKey) return;
  trayMenuKey = key;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showWindow() },
    { type: 'separator' },
    connected || c === 'starting'
      ? { label: '断开连接', click: () => { void disconnect(); } }
      : { label: '连接', enabled: isReady(), click: () => { connect().catch(() => {}); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- IPC ----------
// 所有 IPC 只接受本地界面(index.html)发来的调用:万一窗口里出现了别的页面,它拿不到 preload 的能力里去调这些接口
const RENDERER_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
const fromOwnPage = (frame: Electron.WebFrameMain | null): boolean => {
  const url = frame?.url ?? '';
  return url === RENDERER_URL || (url.startsWith('file://') && url.replace(/\\/g, '/').endsWith('/renderer/index.html'));
};
const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromOwnPage(e.senderFrame)) throw new Error('拒绝:调用不是来自客户端自己的界面');
    return listener(e, ...args);
  });
};
handle('state', () => state);
handle('connect', () => connect());
handle('disconnect', () => disconnect());
handle('check', async () => { log('重新检测', '手动触发重新检测'); await runChecks(); });
handle('repair', async () => {
  if (!mihomo.running) return;
  log('一键修复', '重载网络组件配置、重设 DNS、重新检测');
  await mihomo.reload(join(userData(), 'mihomo', 'config.json')).catch((e) => log('一键修复', '重载配置没成功:' + errorMessage(e)));
  await mihomo.setGate(false).catch(() => {});
  if (state.conn.mode === 'tun') {
    const v = await sysDns.verify().catch(() => ({ reverted: [] as string[], added: [] as string[] }));
    const fixed = [...v.reverted, ...v.added];
    if (fixed.length) log('接管 DNS', `${fixed.join('、')} 的 DNS 已重新指到客户端`);
    await sysDns.flush().catch(() => {});
  }
  state.aiCheck = null;
  await runChecks();
});
handle('protect', () => runChecks());
handle('diagnose', async () => {
  state.diag = await diagnose({
    mihomo, session: checkSession(), expectedIp: state.settings.line.exitIp || null,
    hasIpv6: hasPublicIpv6(networkInterfaces()), mode: state.conn.mode, otherTun: lastOtherTun,
    hasLine: hasLine(), lineReason: lineReason(), hasSubs: enabledSubs(state.settings).length > 0,
  });
  push();
  void runChecks();
});
handle('connections', () => conns.list());
handle('split.test', async (): Promise<SplitRow[]> => {
  if (state.conn.status !== 'connected') return [];
  const s = state.conn.mode === 'tun' ? session.defaultSession : session.fromPartition('system-net');
  if (state.conn.mode !== 'tun') await s.setProxy({ mode: 'system' }).catch(() => {});
  const nodeRoute = enabledSubs(state.settings).length ? 'node' as const : 'direct' as const;
  const ai = state.settings.aiRoutes;
  const targets = [
    ...TARGETS.map((t) => ((t.name === 'ChatGPT' && ai.chatgpt === 'node') || (t.name === 'Gemini' && ai.gemini === 'node')
      ? { ...t, expect: nodeRoute } : t)),
    ...state.settings.rules.map((r) => ({
      lane: 'custom' as const, name: r.domain, url: `https://${r.domain}/`,
      expect: r.route === 'static' ? 'ip' as const : r.route === 'node' ? nodeRoute : 'direct' as const,
    })),
  ];
  const rows = await runSplitTest({
    fetch: async (url, readBody) => {
      const r = await s.fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      return { status: r.status, body: readBody ? await r.text() : '' };
    },
    connections: () => mihomo.connections(),
    hasLine: hasLine(),
    hasSubs: enabledSubs(state.settings).length > 0,
  }, targets);
  const mine = state.settings.line.exitIp || null;
  return rows.map((r) => r.lane === 'ai' && r.expect === 'ip' && r.ip && mine && r.ip !== mine ? { ...r, good: false } : r);
});

handle('settings.set', (_e, patch: Partial<Settings>) => { applySettings(settingsStore.set(patch)); push(); });
handle('settings.reset', async () => { await disconnect(); applySettings(settingsStore.reset()); push(); });
handle('data.open', async () => { await shell.openPath(userData()); });
handle('nodes.list', async () => { state.nodes = mihomo.running ? await mihomo.nodeList().catch(() => null) : null; return state.nodes; });
handle('nodes.test', async () => { if (mihomo.running) await mihomo.checkUserSub(); state.nodes = mihomo.running ? await mihomo.nodeList().catch(() => null) : null; await syncNode(); return state.nodes; });
handle('nodes.refresh', async () => { if (mihomo.running) await mihomo.refreshUserSub(); state.nodes = mihomo.running ? await mihomo.nodeList().catch(() => null) : null; await syncNode(); return state.nodes; });
handle('nodes.select', async (_e, name: string) => {
  const n = typeof name === 'string' ? name : '';
  applySettings(settingsStore.set({ ownNode: n }));
  if (mihomo.running) await mihomo.selectNode(n);
  await syncNode();
  if (mihomo.running && state.conn.status === 'connected' && state.settings.line.viaNode) {
    await mihomo.setFront(PROXY_GROUP);
    await mihomo.checkGroup();
    const g = await mihomo.groupStatus().catch(() => null);
    if (g) state.conn.lineUp = g.lineUp;
    log('换节点', `换成「${n || '自动选择'}」后${g?.lineUp ? '静态 IP 连上了' : '静态 IP 还是连不上'}`);
    if (g?.lineUp) void runChecks();
    push();
  }
  return state.nodes;
});
async function syncNode(): Promise<void> {
  if (!mihomo.running) return;
  state.conn.node = (await mihomo.userSubStatus()).now;
  state.nodes = await mihomo.nodeList().catch(() => null);
  push();
}

handle('cc.check', () => runClaudeCode());
handle('cc.fix', async () => {
  fixClaudeCode(state.settings.mixedPort);
  log('Claude Code', `把 Claude Code 的代理指到客户端(端口 ${state.settings.mixedPort}),原设置已备份`);
  await runClaudeCode();
});
handle('cc.undo', async () => {
  undoClaudeCode();
  log('Claude Code', '撤销了对 Claude Code 代理的修正');
  await runClaudeCode();
});
handle('claude.running', async () => (await listClaude().catch(() => [])).length > 0);
handle('claude.launch', async (_e, kind: 'code' | 'desktop' | 'web') => {
  const port = state.settings.mixedPort;
  if (!mihomo.running) return { ok: false, kind, detail: '还没连接:先连上,再从这里启动,子进程才会走静态 IP' };
  const r = kind === 'web'
    ? await openClaudeWeb(win, port, {
      country: state.env?.country ?? exitCountry,
      followRegion: state.settings.webFollowRegion,
      fpNoise: state.settings.fpNoise,
      fpSeed: state.settings.fpSeed || 1,
      onLog: log,
    })
    : kind === 'desktop' ? await launchClaudeDesktop(port)
      : await launchClaudeCode(port);
  log('启动 Claude', r.detail);
  return r;
});
// 现在有哪些 Claude 在跑(桌面版用安装路径认,其余当命令行)
const isDesktopPath = isDesktop; // 判断只留一份(claude.ts)
// 身份隔离
handle('identity.list', (_e, deep?: boolean) => identities.list(deep === true));
handle('identity.capture', async (_e, name: string) => {
  const r = await identities.capture(String(name ?? ''));
  log('身份', `把当前 Claude 数据归档为新身份「${r.identities.find((x) => x.active)?.name ?? name}」`);
  push();
  return r;
});
handle('identity.activate', async (_e, id: string) => {
  const r = await identities.activate(String(id ?? ''));
  const nm = r.identities.find((x) => x.active)?.name ?? id;
  log('身份', `切换到身份「${nm}」`);
  state.claudeRun = null;
  state.claudeCode = null;
  push();
  return r;
});
handle('identity.rename', (_e, id: string, name: string) => identities.rename(String(id ?? ''), String(name ?? '')));
handle('identity.remove', (_e, id: string) => identities.remove(String(id ?? '')));
handle('identity.kill', () => identities.killClaude());

handle('claude.status', async () => {
  const apps = await listClaude().catch(() => []);
  state.claudeRun = {
    desktop: apps.some((a) => isDesktopPath(a.path)),
    cli: apps.filter((a) => !isDesktopPath(a.path)).length,
  };
  push();
  return state.claudeRun;
});
handle('claude.scan', async () => {
  state.clean = await scanClaude();
  push();
  return state.clean;
});
handle('claude.clean', async (_e, ids: string[], backup: boolean) => {
  await disconnect();
  const r = await cleanClaude(Array.isArray(ids) ? ids.map(String) : [], backup !== false, userData());
  log('清理 Claude 残留', `删除了 ${r.removed.length} 项${r.backupDir ? `,备份在 ${r.backupDir}` : ''}${r.errors.length ? `,${r.errors.length} 项失败` : ''}`);
  state.clean = await scanClaude();
  push();
  return r;
});
// 以管理员身份重启:先起一个延时的提权进程,再退出当前实例(否则单实例锁会吞掉新实例)
handle('relaunchAsAdmin', async () => {
  if (process.platform !== 'win32') return { ok: false, detail: '只支持 Windows' };
  const exe = app.getPath('exe').replace(/'/g, "''");
  try {
    const { spawn } = await import('node:child_process');
    spawn('powershell', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds 2000; Start-Process -FilePath '${exe}' -Verb RunAs`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    setTimeout(() => { quitting = true; app.quit(); }, 300);
    return { ok: true, detail: '正在请求管理员权限;同意 UAC 后会自动重启' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
});
handle('settings.backups', () => settingsStore.backups());
handle('settings.restore', async (_e, name: string) => {
  const s = settingsStore.restore(String(name ?? ''));
  applySettings(s);
  log('设置', `已从备份恢复设置(${name})`);
  push();
});
handle('fpReset', () => {
  const seed = Math.floor(Math.random() * 2 ** 31) + 1;
  applySettings(settingsStore.set({ fpSeed: seed, fpNoise: true }));
  log('指纹', `已重置内置窗口的指纹种子(${seed})`);
  push();
});
handle('env.recheck', async () => { state.env = buildEnvReport(exitCountry); push(); });
// 静态 IP 自检:经节点优先,内核没跑就直连
handle('line.test', async (_e, line: Line) => {
  const r = await testLine(line, mihomo.running ? { mixedPort: state.settings.mixedPort } : {});
  log('静态 IP 自检', `路径 ${r.via === 'node' ? '经节点' : '直连'} · ${r.steps.map((x) => `${x.label}:${x.ok === true ? 'OK' : x.ok === false ? '失败' : '未定'}`).join(' | ')}`);
  push();
  return r;
});
handle('claude.dismiss', () => { state.claudeApps = null; push(); });
// 长跑指标(不写盘、不上报):界面和 tools/soak.mjs 都能读
handle('stats.get', () => ({ ...stats, logBytes: mihomo.logSize }));

// 诊断报告里不能带真实网络身份:出口 IP 用来说明问题,但要能发给别人看
const maskIp = (s: string): string => s
  .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (_m, a: string, b: string, c: string) => `${a}.${b}.${c}.x`)
  .replace(/\b([0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}\b/gi, (m) => (m.includes('::') ? m : '[v6]'));

handle('diag.copy', () => {
  const c = state.conn;
  const s = state.settings;
  // 订阅链接带机场令牌,报告里只留主机名;静态 IP 的账号密码、出口 IP、内核日志里的访问历史都不放进来
  const safeLine = { ...s.line, username: s.line.username ? '***' : '', password: s.line.password ? '***' : '', server: s.line.server ? maskIp(s.line.server) : '', exitIp: s.line.exitIp || '' };
  const lines = [
    `AI Network Clean ${state.version}${state.packaged ? '' : '(开发版)'} · ${new Date().toISOString()}`,
    `静态 IP ${hasLine() ? `${s.line.type}://${safeLine.server}:${s.line.port}${s.line.viaNode ? '(经节点)' : ''}` : '-'} · 期望出口 ${s.line.exitIp ? '已填' : '-'} · 管理员 ${state.admin}`,
    `连接 ${c.status} · 模式 ${c.mode} · 线路 ${c.lineUp} · 出口 ${c.exitIp ? maskIp(c.exitIp) : '-'}${c.node ? ` · 节点 ${c.node}` : ''}`,
    c.warning ? `提示:${c.warning}` : '', c.error ? `错误:${c.error}` : '',
    connectTimings.length ? `最近一次连接各步(累计用时):${connectTimings.join(' → ')}` : '',
    `运行指标:${describeStats(stats)}`,
    `设置:${JSON.stringify({ ...s, line: safeLine, subs: s.subs.map((x) => `${x.name}(${safeHost(x.url) ?? '格式不对'})${x.enabled ? '' : '·未用'}`) })} · 其他代理软件:${lastOtherTun ?? '无'}`,
    '',
    ...(state.diag ? [`诊断 ${state.diag.at}:${state.diag.summary}`, ...state.diag.steps.map((x) => `  [${x.state}] ${x.title}:${x.detail}`), ...state.diag.advice.map((a) => `  建议:${a}`), ''] : []),
    ...(state.protect ? [`防护检测 ${state.protect.at}:出口 ${state.protect.ip.state}(${state.protect.ip.detail}) · DNS ${state.protect.dns.state}(${state.protect.dns.detail}) · WebRTC ${state.protect.webrtc.state}(${state.protect.webrtc.detail})`, ''] : []),
    '最近的连接日志:',
    ...state.log.slice(-30).map((e) => `  ${e.at} [${e.kind}] ${maskIp(e.text)}`),
    '', '内核日志:不在诊断报告里(含访问过的全部域名和程序名,要看得去「日志」页或数据目录的 mihomo.log)',
  ].filter((l) => l !== undefined);
  clipboard.writeText(maskIp(lines.join('\n')));
  return lines.length;
});
function safeHost(u: string): string | null { try { return new URL(u).host; } catch { return null; } }

handle('copy', (_e, text: string) => clipboard.writeText(String(text).slice(0, 4000)));
handle('log.export', async () => {
  const r = await dialog.showSaveDialog(win!, {
    title: '导出连接日志',
    defaultPath: join(app.getPath('documents'), `AI-Network-Clean-连接日志-${new Date().toISOString().slice(0, 10)}.txt`),
    filters: [{ name: '文本', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  writeFileSync(r.filePath, '\ufeff' + `AI Network Clean 连接日志 · ${new Date().toISOString()}\r\n\r\n` + maskIp(connLog.text()));
  return r.filePath;
});
handle('anomaly.export', async () => {
  const r = await dialog.showSaveDialog(win!, {
    title: '导出异常连接记录',
    defaultPath: join(app.getPath('documents'), `AI-Network-Clean-异常连接-${new Date().toISOString().slice(0, 10)}.txt`),
    filters: [{ name: '文本', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const events = connLog.all().filter(isAbnormalEvent).map((e) => `${new Date(e.at).toLocaleString('zh-CN', { hour12: false })}  [${e.kind}]  ${e.text}`).join('\r\n');
  writeFileSync(r.filePath, '\ufeff' + `AI Network Clean 异常连接记录\r\n\r\n== 异常事件 ==\r\n${events || '(没有)'}\r\n\r\n== 被拦住、没走静态 IP 或连不上的 AI 连接 ==\r\n${maskIp(anomalies.text()) || '(没有)'}\r\n`);
  return r.filePath;
});
handle('open.url', (_e, url: string) => { try { if (new URL(url).protocol === 'https:') return shell.openExternal(url); } catch { /* 不是地址 */ } });
handle('win.show', (_e, page?: string) => showWindow(typeof page === 'string' ? page : undefined));
handle('tray.hide', () => trayWin?.hide());
handle('quit', () => { quitting = true; app.quit(); });

// ---------- 启动 ----------
async function bootConnect(): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000 && state.settings.autoConnect && (state.conn.status === 'disconnected' || state.conn.status === 'failed')) {
    if (await networkReady()) break;
    state.conn.warning = '正在等电脑连上网络，连上后会自动连接…';
    push();
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (state.conn.warning?.startsWith('正在等电脑连上网络')) { state.conn.warning = null; push(); }
  for (let i = 0; i < 4; i++) {
    const cur = state.conn.status as string;
    if (cur === 'connected' || !state.settings.autoConnect) return;
    if (cur !== 'starting') await connect().catch(() => {});
    if ((state.conn.status as string) === 'connected') return;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    await session.defaultSession.setProxy({ mode: 'direct' }).catch(() => {});
    state.admin = await isAdmin();
    lastOtherTun = await otherTunAdapter().catch(() => null);
    state.externalTun = await detectExternalTun().catch(() => null);
    state.tunAvailable = state.admin && !lastOtherTun;
    applySettings(state.settings);
    state.log = connLog.recent();
    state.abnormal = connLog.all().filter(isAbnormalEvent).slice(-100);
    state.claudeSeen = claudeSeenToday(connLog.all());
    state.anomalies = anomalies.recent();
    void syncAutoStart();
    powerMonitor.on('resume', () => {
      if (state.conn.status !== 'connected') return;
      log('唤醒', '电脑从睡眠中唤醒,重新检测防护');
      setTimeout(() => void runChecks(), 5000);
    });
    if (sysDns.pending()) { await sysDns.restore().catch(() => {}); log('恢复 DNS', '上次退出时没来得及恢复物理网卡的 DNS,已恢复'); }
    if (sysProxy.pending()) { await sysProxy.restore().catch(() => {}); log('恢复系统代理', '上次退出时没来得及还原系统代理,已还原'); }
    createWindow();
    createTray();
    push();
    if (state.settings.autoConnect && isReady()) void bootConnect();
  });
}

app.on('before-quit', (e) => {
  quitting = true;
  stopPolling();
  suspendClaudeCodeFix();
  if (!quitCleanupDone && (mihomo.running || sysDns.pending() || sysProxy.pending())) {
    e.preventDefault();
    const cap = new Promise<void>((ok) => setTimeout(ok, 8000));
    void Promise.race([(async () => { await mihomo.stop(); await sysDns.restore(); await sysProxy.restore(); })().catch(() => {}), cap]).finally(() => { quitCleanupDone = true; app.quit(); });
  }
});
let quitCleanupDone = false;

app.on('window-all-closed', async () => {
  if (state.settings.keepBackground && !quitting) return;
  await mihomo.stop();
  app.quit();
});

export type { Line, LogEntry, Anomaly, ClaudeSeen, ClaudeStatus, DiagReport, AiCheck, CcReport, NodeList };

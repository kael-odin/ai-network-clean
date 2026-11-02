// 主进程 / 预加载 / 界面三方共用的类型
// 纯净版契约:没有账号、没有设备、没有计费;唯一的外部输入是「你自己的静态 IP」和「你自己的订阅」

// ---------- 设置 ----------
export type LineType = 'socks5' | 'http' | 'none';
export type TunMode = 'auto' | 'on' | 'off';

// 你自己的静态 IP(固定出口)。type='none' 表示没填,此时 AI 流量走订阅节点
export interface Line {
  type: LineType;
  server: string;
  port: number;
  username: string;
  password: string;
  // 你期望的出口 IP(填了才会校验「AI 网站看到的 IP 对不对」)
  exitIp: string;
  // 静态 IP 直连不通时,先经订阅节点再到它(类似 Clash 的 dialer-proxy)
  viaNode: boolean;
}

export interface Sub {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

// AI 服务走哪条线:static = 你的静态 IP,node = 你的订阅节点
export type AiRoute = 'static' | 'node';
export interface AiRoutes {
  chatgpt: AiRoute;
  gemini: AiRoute;
  grok: AiRoute;
  meta: AiRoute;
}

export type RuleRoute = 'static' | 'node' | 'direct';
export interface UserRule {
  domain: string;
  route: RuleRoute;
}

export interface Settings {
  autoStart: boolean;        // 开机启动(Windows 登录后,窗口不弹出)
  autoConnect: boolean;      // 启动后自动连接
  keepBackground: boolean;   // 关闭窗口时留在托盘
  tun: TunMode;              // auto = 有管理员权限且没别的虚拟网卡就用 TUN
  mixedPort: number;         // 本地代理端口
  controllerPort: number;    // 内核控制端口(127.0.0.1)
  line: Line;                // 你的静态 IP
  subs: Sub[];               // 节点订阅(可以多条,同一时间只用一条)
  ownNode: string;           // 手动固定节点(空 = 自动选最快)
  aiRoutes: AiRoutes;
  rules: UserRule[];         // 自己的网站分流规则
  autoRegion: string;        // 自动选最快限定的地区('' = 全部)
  homeRegion: string;        // 本地直连的国家/地区代码(国内网站直连用),默认 CN
  claudeCodeFix: boolean;    // 连上时自动把 Claude Code 的代理指到本客户端(断开/退出时还原)
  webFollowRegion: boolean;  // 内置 Claude 窗口把时区/语言调到出口国家(减少"IP 在纽约、时区在北京"的矛盾)
  favNodes: string[];        // 收藏/置顶的节点(节点页排最前)
  fpNoise: boolean;          // 内置 Claude 窗口加 Canvas/WebGL 指纹噪声(每次读取极微小扰动)
  fpSeed: number;            // 噪声种子:同一个种子 = 同一个"设备指纹",换种子 = 换一台机器
}

// ---------- 节点 ----------
export interface NodeInfo {
  name: string;
  type: string;
  delay: number | null;
  alive: boolean;
  udp: boolean;
  provider: string;
  region: string;   // HK/TW/JP/SG/US/KR/OTHER,从节点名认
}
export interface NodeList {
  nodes: NodeInfo[];
  selected: string;          // 「普通代理」组选中的
  effective: string | null;  // 实际在用的节点
  updatedAt: string | null;
  auto: string;
}
export interface SubSummary {
  total: number;
  placeholders: string[];
  usable: number;
  now: string | null;
}

// ---------- 连接状态 ----------
export type ConnStatus = 'disconnected' | 'starting' | 'connected' | 'failed';

export interface ConnState {
  status: ConnStatus;
  mode: 'tun' | 'proxy';
  lineUp: boolean | null;     // 静态 IP 健康检查是否通过
  exitIp: string | null;      // 实际出口 IP
  expectedIp: string | null;  // 期望出口(静态 IP 里填的)
  node: string | null;        // 订阅当前节点
  front: string | null;       // 去静态 IP 那一跳用的节点
  error: string | null;
  warning: string | null;
  checkedAt: string | null;
  since: string | null;
  recovered: string | null;
  downSince: string | null;
  downReason: string | null;
}

// ---------- 防护 ----------
export type ProtectState = 'ok' | 'fail' | 'unknown';
export interface ProtectItem {
  state: ProtectState;
  detail: string;
  inconclusive?: boolean;
}
export interface ProtectReport {
  at: string;
  ip: ProtectItem;
  dns: ProtectItem;
  ipv6: ProtectItem;
  webrtc: ProtectItem;
  route?: ProtectItem;
  conflict?: ProtectItem;
}

export type CheckState = 'ok' | 'fail' | 'unknown';
export interface AiCheck {
  state: 'waiting' | 'blocked' | 'done';
  reason: string | null;
  sites: { name: string; ok?: boolean; ip?: string | null }[];
  warn?: string | null;
}

// ---------- 日志与连接 ----------
export interface LogEntry {
  at: string;
  kind: string;
  text: string;
}
export type AnomalyKind = 'blocked' | 'leak' | 'failed';
export interface Anomaly {
  at: string;
  last: string;
  kind: AnomalyKind;
  proc: string;
  host: string;
  count: number;
  reason: string;
}
export type RouteKind = 'ip' | 'node' | 'direct' | 'blocked';
export interface Conn {
  id: string;
  host: string;
  port: string;
  process: string;
  service: string | null;
  route: RouteKind;
  node: string | null;
  start: string;
  closedAt: string | null;
  up: number;
  down: number;
}

// ---------- Claude ----------
export interface ClaudeSeen {
  ip: string | null;
  at: string | null;
  today: string[];
  checks: number;
}
export interface ClaudeStatus {
  level: 'ok' | 'minor' | 'major' | 'maintenance';
  text: string;
  at: string;
}
export interface ClaudeProc {
  pid: number;
  ppid: number;
  path: string;
  started: number;
}
export interface ClaudeApps {
  desktop: ClaudeProc | null;
  cli: number;
}
export type CcState = 'ok' | 'warn';
export interface CcReport {
  at: string;
  state: CcState;
  detail: string;
  proxy: string | null;
  source: string | null;
  fixable: boolean;
  fixed: boolean;
}

// ---------- 静态 IP 自检 ----------
export interface LineTestStep {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
}
export interface LineTestResult {
  at: string;
  via: 'direct' | 'node';
  protocol: 'http' | 'socks5' | 'unknown';
  steps: LineTestStep[];
  raw: string;
}

// ---------- 环境一致性(CCBaga 思路:出口国家 / 时区 / 语言 要对得上) ----------
export interface EnvItem {
  key: string;
  label: string;
  expected: string;
  actual: string;
  ok: boolean | null;
  hint?: string;
}
export interface EnvReport {
  at: string;
  country: string | null;
  ok: boolean;
  items: EnvItem[];
}

// ---------- Claude 本地残留清理 ----------
export interface CleanTarget {
  id: string;
  label: string;
  path: string;
  group: 'session' | 'cache' | 'auth';
  note: string;
  bytes: number;
  files: number;
  exists: boolean;
}
export interface CleanScan {
  at: string;
  targets: CleanTarget[];
  totalBytes: number;
}
export interface CleanResult {
  at: string;
  removed: string[];
  bytes: number;
  backupDir: string | null;
  errors: string[];
}

// ---------- 身份隔离(多账号各自独立的 Claude 本地数据) ----------
export interface IdentityInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  active: boolean;
  bytes: number;
  files: number;
  account: string | null;   // 账号标识(.claude.json 的 userID 前 8 位),用来分辨"哪个身份是哪个号"
  projects: number;         // 会话里出现过多少个项目
  lastActiveAt: string | null;  // 最近一次有文件变动的时间(判断"哪个号最近在用")
}
export interface IdentityState {
  at: string;
  activeId: string | null;
  identities: IdentityInfo[];
  live: { claude: boolean; claudeJson: boolean; appdata: boolean; bytes: number; files: number; account: string | null; measured: boolean };
  claudeRunning: { desktop: boolean; cli: number } | null;
}

// ---------- 从客户端启动 Claude ----------
export type LaunchKind = 'code' | 'desktop' | 'web';
export interface LaunchResult {
  ok: boolean;
  detail: string;
  kind: LaunchKind;
}

// ---------- 诊断与分流测试 ----------
export interface DiagStep {
  key: string;
  title: string;
  state: 'ok' | 'fail' | 'warn' | 'skip';
  detail: string;
}
export interface DiagReport {
  at: string;
  steps: DiagStep[];
  summary: string;
  advice: string[];
  sites: { name: string; ok: boolean }[];
}
export interface SplitRow {
  lane: 'ai' | 'foreign' | 'cn' | 'custom';
  name: string;
  host: string;
  ok: boolean;
  ms: number | null;
  status: number | null;
  route: RouteKind | 'outside' | null;
  node: string | null;
  ip: string | null;
  country: string | null;
  expect: 'ip' | 'node' | 'direct';
  good: boolean;
}

// ---------- 界面状态 ----------
// 运行指标(长跑观察用):进程起来之后累计发生了什么
export interface RuntimeStats {
  startedAt: string;
  connects: number;
  connectFailures: number;
  autoRecovers: number;
  reconnected: number;
  fullChecks: number;
  lightChecks: number;
  quickChecks: number;
  gateOpens: number;
  gateBlocks: number;
  leaks: number;
  dnsReverts: number;
  netChanges: number;
  subRefreshes: number;
  logBytes: number;
}

export interface AppState {
  step: 'setup' | 'ready';
  conn: ConnState;
  settings: Settings;
  protect: ProtectReport | null;
  protectChecking: boolean;
  aiCheck: AiCheck | null;
  claudeSeen: ClaudeSeen | null;
  claudeStatus: ClaudeStatus | null;
  claudeApps: ClaudeApps | null;
  claudeCode: CcReport | null;
  claudeRun: { desktop: boolean; cli: number } | null;   // 现在有哪些 Claude 在跑(检测子进程绕过)
  env: EnvReport | null;                                  // 出口国家 vs 本机环境
  clean: CleanScan | null;                                // Claude 本地残留扫描结果
  nodes: NodeList | null;
  diag: DiagReport | null;
  log: LogEntry[];
  abnormal: LogEntry[];
  anomalies: Anomaly[];
  connections: Conn[];
  closedConns: Conn[];
  quickAt: string | null;
  version: string;
  admin: boolean;
  packaged: boolean;
  tunAvailable: boolean;     // 管理员权限 + 没有别的虚拟网卡
  // 别的程序的虚拟网卡(多半是 Clash)正占着默认路由:本客户端的「直连」其实会经它出去
  externalTun: { name: string; description: string } | null;
  stats: RuntimeStats;       // 长跑指标(内存里累计,不写盘)
}

// ---------- preload 暴露的接口 ----------
export interface AinApi {
  state: () => Promise<AppState>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  check: () => Promise<void>;
  repair: () => Promise<void>;
  diagnose: () => Promise<void>;
  protect: () => Promise<void>;
  splitTest: () => Promise<SplitRow[]>;
  connections: () => Promise<{ active: Conn[]; closed: Conn[] }>;

  setSettings: (patch: Partial<Settings>) => Promise<void>;
  resetSettings: () => Promise<void>;
  openDataDir: () => Promise<void>;
  refreshNodes: () => Promise<NodeList | null>;
  testNodes: () => Promise<NodeList | null>;
  selectNode: (name: string) => Promise<NodeList | null>;

  ccCheck: () => Promise<void>;
  ccFix: () => Promise<void>;
  ccUndo: () => Promise<void>;
  claudeRunning: () => Promise<boolean>;
  claudeDismiss: () => Promise<void>;
  claudeLaunch: (kind: LaunchKind) => Promise<LaunchResult>;
  claudeStatus: () => Promise<{ desktop: boolean; cli: number } | null>;
  claudeScan: () => Promise<CleanScan>;
  claudeClean: (ids: string[], backup: boolean) => Promise<CleanResult>;
  envRecheck: () => Promise<void>;
  lineTest: (line: Line) => Promise<LineTestResult>;
  relaunchAsAdmin: () => Promise<{ ok: boolean; detail: string }>;
  fpReset: () => Promise<void>;
  settingsBackups: () => Promise<string[]>;
  settingsRestore: (name: string) => Promise<void>;
  // 身份隔离
  identities: (deep?: boolean) => Promise<IdentityState>;
  identityCapture: (name: string) => Promise<IdentityState>;
  identityActivate: (id: string) => Promise<IdentityState>;
  identityRename: (id: string, name: string) => Promise<IdentityState>;
  identityRemove: (id: string) => Promise<IdentityState>;
  identityKillClaude: () => Promise<{ killed: number }>;

  copyDiag: () => Promise<number>;
  copyText: (text: string) => Promise<void>;
  exportLog: () => Promise<string | null>;
  exportAnomalies: () => Promise<string | null>;
  openUrl: (url: string) => Promise<void>;
  showWindow: (page?: string) => Promise<void>;
  hideTray: () => Promise<void>;
  quit: () => Promise<void>;

  onState: (cb: (s: AppState) => void) => () => void;
  onNav: (cb: (page: string) => void) => () => void;
}

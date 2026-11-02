// Claude Code 代理检测(PM 10-19 第一批):Claude Code 走不走独享 IP,取决于它的代理设置。
// 它读环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY,~/.claude/settings.json 的 env 优先。
// 指向我们的端口或没设(虚拟网卡模式下直连会被接管)= 正常;指向 Clash 等别的程序、或指向没人在听的端口 = 提示,并可一键修正:
// 在 settings.json 的 env 里把代理指到客户端的本地端口,原来的值备份下来,可以撤销。
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CcReport, CcState } from '../shared/ipc.ts';
export type { CcReport, CcState };

const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const FIX_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY'];
const settingsPath = () => join(homedir(), '.claude', 'settings.json');

const run = (file: string, args: string[]) => new Promise<string>((ok) => execFile(file, args, { windowsHide: true, timeout: 10_000 }, (_e, out) => ok(String(out ?? ''))));

// 注册表里的用户级、系统级环境变量(客户端自己的进程环境是启动时继承的,不一定是 Claude Code 看到的)
async function regEnv(key: string): Promise<Record<string, string>> {
  if (process.platform !== 'win32') return {};
  const out = await run('reg', ['query', key]);
  const env: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
    if (m && KEYS.includes(m[1])) env[m[1]] = m[2].trim();
  }
  return env;
}

function readSettings(): Record<string, unknown> | null {
  try { return existsSync(settingsPath()) ? (JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>) : null; } catch { return null; }
}
const pick = (env: Record<string, unknown> | undefined): string | null => {
  for (const k of KEYS) { const v = env?.[k]; if (typeof v === 'string' && v.trim()) return v.trim(); }
  return null;
};

// 实际生效的代理和它来自哪里:settings.json 的 env > 用户环境变量 > 系统环境变量
export async function effectiveProxy(): Promise<{ proxy: string | null; source: string | null }> {
  const fromSettings = pick(readSettings()?.env as Record<string, unknown> | undefined);
  if (fromSettings) return { proxy: fromSettings, source: 'Claude Code 设置(~/.claude/settings.json)' };
  const user = pick(await regEnv('HKCU\\Environment'));
  if (user) return { proxy: user, source: '用户环境变量' };
  const machine = pick(await regEnv('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'));
  if (machine) return { proxy: machine, source: '系统环境变量' };
  // Windows 的系统代理:Claude 桌面版启动时会把它当成 HTTPS_PROXY 传给里面跑的 Claude Code(10-19 在 PM 电脑上看到的就是这样)
  const inet = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/.test(inet);
  const server = inet.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
  if (enabled && server) return { proxy: server.split(';').map((x) => x.replace(/^\w+=/, ''))[0], source: '系统代理(Claude 桌面版会把它传给 Claude Code)' };
  return { proxy: null, source: null };
}

// 本机端口是谁在听:返回进程 ID,没人听返回 null
async function portOwner(port: number): Promise<{ pid: number; name: string } | null> {
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "$($c.OwningProcess)|$($p.ProcessName)" }`]);
  const [pid, name] = out.trim().split('|');
  return pid ? { pid: Number(pid), name: name || '未知程序' } : null;
}

export async function checkClaudeCode(o: { ourPid: number | null; ourPort: number; tun: boolean; connected: boolean }): Promise<CcReport> {
  const at = new Date().toISOString();
  const fixed = existsSync(backupPath());
  const { proxy, source } = await effectiveProxy();
  const base = { at, proxy, source, fixed };
  if (!proxy) {
    return o.tun
      ? { ...base, state: 'ok', detail: 'Claude Code 没设代理,直接出网,由虚拟网卡接管走静态 IP', fixable: false }
      : { ...base, state: 'warn', detail: 'Claude Code 没设代理,本地代理模式下它不经过客户端,不会走静态 IP', fixable: true };
  }
  let url: URL | null = null;
  try { url = new URL(/^\w+:\/\//.test(proxy) ? proxy : 'http://' + proxy); } catch { /* 写法不对 */ }
  if (!url) return { ...base, state: 'warn', detail: `Claude Code 的代理「${proxy}」写法不对,它可能连不上`, fixable: true };
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (!local) return { ...base, state: 'warn', detail: `Claude Code 的代理指向 ${url.host}(来自${source}),AI 流量会从那里出去,不是你的静态 IP`, fixable: true };
  const port = Number(url.port || 80);
  const owner = await portOwner(port);
  if (owner && o.ourPid && owner.pid === o.ourPid) return { ...base, state: 'ok', detail: `Claude Code 的代理指向客户端(端口 ${port}),走静态 IP`, fixable: false };
  if (!owner) return { ...base, state: 'warn', detail: `Claude Code 的代理指向本机端口 ${port}(来自${source}),但没有程序在听,Claude Code 会连不上`, fixable: true };
  return { ...base, state: 'warn', detail: `Claude Code 的代理指向本机端口 ${port},那是「${owner.name}」(多半是 Clash),AI 流量会从它的节点出去,不是你的静态 IP`, fixable: true };
}

// ---- 一键修正 / 撤销 ----
let backupDir = '';
export function setBackupDir(dir: string): void { backupDir = dir; }
const backupPath = () => join(backupDir || homedir(), 'claudecode-proxy-backup.json');
// 用户点过「一键修正」、还没点「撤销修正」(PM 10-23 巡查:修正写死了客户端的端口,客户端一关 Claude Code 就连不上;
// 改成断开、退出时先撤销,下次连上再自动改回去)
const wantedPath = () => join(backupDir || homedir(), 'claudecode-proxy-wanted');

// 把 settings.json 的 env 里的代理指到客户端;改之前整份文件另存一份,并记下原来的几个键,撤销时只还原这几个键
export function fixClaudeCode(port: number): void {
  try { writeFileSync(wantedPath(), new Date().toISOString()); } catch { /* 记不下来就只是下次不自动改回 */ }
  const file = settingsPath();
  const cur = readSettings() ?? {};
  if (existsSync(file)) copyFileSync(file, file + '.ain-backup');
  const env = { ...((cur.env ?? {}) as Record<string, unknown>) };
  if (!existsSync(backupPath())) writeFileSync(backupPath(), JSON.stringify({ at: new Date().toISOString(), had: Object.fromEntries([...FIX_KEYS, 'NO_PROXY'].map((k) => [k, env[k] ?? null])) }));
  for (const k of FIX_KEYS) env[k] = `http://127.0.0.1:${port}`;
  env.NO_PROXY = 'localhost,127.0.0.1';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...cur, env }, null, 2) + '\n');
}

// forget:用户自己点「撤销修正」时为 true,以后不再自动改回;断开、退出时的临时撤销传 false
export function undoClaudeCode(forget = true): void {
  if (forget) { try { unlinkSync(wantedPath()); } catch { /* 本来就没有 */ } }
  if (!existsSync(backupPath())) return;
  const { had } = JSON.parse(readFileSync(backupPath(), 'utf8')) as { had: Record<string, unknown> };
  const cur = readSettings();
  if (cur) {
    const env = { ...((cur.env ?? {}) as Record<string, unknown>) };
    for (const [k, v] of Object.entries(had)) { if (v === null) delete env[k]; else env[k] = v; }
    const next = { ...cur, env } as Record<string, unknown>;
    if (Object.keys(env).length === 0) delete next.env;
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n');
  }
  unlinkSync(backupPath());
}

// 断开、退出时:改过就先撤销(Claude Code 回到原来的代理设置,客户端不在时也能用)
export function suspendClaudeCodeFix(): void {
  try { undoClaudeCode(false); } catch { /* settings.json 读写失败不影响断开 */ }
}
// 连上时:用户要过修正、现在没改着,就再改回去
export function resumeClaudeCodeFix(port: number): boolean {
  if (!existsSync(wantedPath()) || existsSync(backupPath())) return false;
  try { fixClaudeCode(port); return true; } catch { return false; }
}

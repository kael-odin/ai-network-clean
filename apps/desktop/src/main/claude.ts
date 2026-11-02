// 产品围绕 Claude 优化(PM 10-22 第一批):
// C1 首页「Claude 看到的你」:Claude 看到的出口是不是独享 IP、今天有没有变过(从连接日志里的出口核对记录算)
// C5 Claude 官方状态:读 status.claude.com,官方出故障时首页黄条说明「不是你的网络」,不算网络异常、不关 AI 闸门
// C3 连接前就开着的 Claude 桌面版:它已经建立的连接还走原来的网络,只提示用户空闲时自己重开(PM 10-22 去掉了一键重开:会把跑在 Claude 里的任务和远程会话一起关掉)
import { execFile } from 'node:child_process';
import type { LogEntry } from './connlog.ts';

// ---------- C1 ----------
import type { ClaudeApps, ClaudeProc, ClaudeSeen, ClaudeStatus } from '../shared/ipc.ts';
export type { ClaudeApps, ClaudeProc, ClaudeSeen, ClaudeStatus };

const IP_RE = /Claude (?:看到的是|看到) (\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+:[0-9a-f:]+)/i;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// 连接日志里「出口核对」「拦截 AI」两类记录写着 Claude 看到的 IP:取今天(本地时间)的,按出现顺序去重
export function claudeSeenToday(entries: LogEntry[], now = new Date()): ClaudeSeen {
  const today: string[] = [];
  let last: { ip: string; at: string } | null = null;
  let checks = 0;
  for (const e of entries) {
    if (e.kind !== '出口核对' && e.kind !== '拦截 AI') continue;
    const ip = IP_RE.exec(e.text)?.[1];
    if (!ip || !sameDay(new Date(e.at), now)) continue;
    checks++;
    last = { ip, at: e.at };
    if (!today.includes(ip)) today.push(ip);
  }
  return { ip: last?.ip ?? null, at: last?.at ?? null, today, checks };
}

// ---------- C5 ----------

export const STATUS_URL = 'https://status.claude.com/api/v2/summary.json';

interface Summary {
  status?: { indicator?: string; description?: string };
  incidents?: { name?: string; status?: string; impact?: string }[];
  scheduled_maintenances?: { name?: string; status?: string }[];
}

// Statuspage 的 summary.json:indicator 是 none / minor / major / critical(maintenance 是维护中)。
// 有未结束的事故时 text 用事故标题(英文原文,用户可以对照官方页面);没有就用总体描述
export function parseClaudeStatus(json: unknown, now = new Date()): ClaudeStatus | null {
  const s = json as Summary;
  const ind = s?.status?.indicator;
  if (!ind) return null;
  const open = (s.incidents ?? []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem');
  const maint = (s.scheduled_maintenances ?? []).filter((m) => m.status === 'in_progress');
  const level: ClaudeStatus['level'] = ind === 'none' ? (maint.length ? 'maintenance' : 'ok')
    : ind === 'maintenance' ? 'maintenance' : ind === 'minor' ? 'minor' : 'major';
  const text = open.map((i) => i.name).filter(Boolean).join(';') || maint.map((m) => m.name).filter(Boolean).join(';') || s.status?.description || '';
  return { level, text, at: now.toISOString() };
}

// ---------- C3 ----------


// Claude 桌面版:微软商店版装在 WindowsApps\Claude_…,老的安装包版在 AnthropicClaude 下。
// 其他叫 claude.exe 的是 Claude Code(命令行);桌面版自带的 Claude Code 是桌面版的子进程,不单独算
const isDesktop = (p: string) => /\\WindowsApps\\Claude_|\\AnthropicClaude\\/i.test(p);

// 找连接前(before 之前)就开着的 Claude:桌面版取主进程(父进程不是桌面版的那个),命令行的数一下个数
export function pickClaude(list: ClaudeProc[], before: number): ClaudeApps {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const desktop = list.find((p) => isDesktop(p.path) && !(byPid.get(p.ppid) && isDesktop(byPid.get(p.ppid)!.path)) && p.started < before) ?? null;
  const underDesktop = (p: ClaudeProc) => { const parent = byPid.get(p.ppid); return !!parent && isDesktop(parent.path); };
  const cli = list.filter((p) => !isDesktop(p.path) && !underDesktop(p) && p.started < before).length;
  return { desktop, cli };
}

const ps = (cmd: string) => new Promise<string>((ok) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + cmd], { windowsHide: true, timeout: 15_000 }, (_e, out) => ok(String(out ?? ''))));

export async function listClaude(): Promise<ClaudeProc[]> {
  if (process.platform !== 'win32') return [];
  const out = await ps("Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { '' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + '|' + $_.ExecutablePath }");
  return out.split(/\r?\n/).map((l) => l.trim().split('|')).filter((x) => x.length >= 4 && x[3])
    .map(([pid, ppid, started, ...path]) => ({ pid: Number(pid), ppid: Number(ppid), started: Number(started), path: path.join('|') }));
}

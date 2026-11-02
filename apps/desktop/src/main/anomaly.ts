// 异常连接记录(PM 10-20 定「1+2」):
// 1. 异常事件:连接日志里的异常(意外断开、连接失败、拦截 AI、DNS 被改回、出口不一致、订阅到期等)单独列出来
// 2. AI 连接明细:从网络组件(mihomo)的连接日志里认出两种情况,记下是哪个程序、访问哪个网站:
//    - 被拦:AI 闸门关着时 AI 网站的连接(using AI Network 放行[REJECT])
//    - 没走独享 IP:AI 网站的连接走了直连或普通节点(规则没认出来,或被别的规则抢走了)
//    - 连不上(PM 10-23):走独享 IP 的 AI 连接没连成(超时、被断开等),只记录不提示,用户说「Claude 又断了」时有据可查
// 同一个程序访问同一个网站、同一种情况,一分钟内合成一条(带次数),避免刷屏。存在 anomalies.jsonl,只留最近 2000 条
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from './connlog.ts';
import { AI_GATE, AI_GROUP } from './config.ts';

import type { Anomaly, AnomalyKind } from '../shared/ipc.ts';
export type { Anomaly, AnomalyKind };
export interface ConnLine { proto: string; proc: string; host: string; port: number; rule: string; group: string; node: string }

// 内核日志的一行:[TCP] 198.18.0.1:56314(chrome.exe) --> api.anthropic.com:443 match RuleSet(x) using AI Network 放行[AI Network · US]
const LINE = /\[(TCP|UDP)\] \S+?(?:\(([^)]+)\))? --> (\S+):(\d+) match (.+?) using ([^\[\]"]+?)(?:\[([^\]]+)\])?"?\s*$/;
export function parseConnLine(line: string): ConnLine | null {
  const m = LINE.exec(line);
  if (!m) return null;
  return { proto: m[1], proc: m[2] ?? '', host: m[3], port: Number(m[4]), rule: m[5], group: m[6].trim(), node: m[7] ?? m[6].trim() };
}

// 认作 AI 网站的域名(用来发现「AI 网站没走独享 IP」)。只看 Claude(PM 10-23:ChatGPT、Gemini 只保留路由规则,不检测)
const AI_SUFFIX = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com'];
export const isAiHost = (h: string): boolean => AI_SUFFIX.some((s) => h === s || h.endsWith('.' + s));
// 客户端自己(出口核对、诊断)和内核自己的连接不算。
// 客户端进程名是「AI Network Clean.exe」(productName),不是 ain-clean,按前缀认,免得自己的出口核对被记成 AI 连接
const SELF = /^(AI Network|ain-clean|mihomo.*|electron\.exe)$/i;

// 内核连不上时的一行:[TCP] dial AI Network 放行 (match RuleSet/x) 198.18.0.1:52000(chrome.exe) --> claude.ai:443 error: … i/o timeout
const FAIL = /\[(TCP|UDP)\] dial (.+?) (?:\(match [^)]*\) )?\S+?(?:\(([^)]+)\))? --> (\S+):(\d+) error: (.*?)"?\s*$/;
export interface FailLine { group: string; proc: string; host: string; error: string }
export function parseFailLine(line: string): FailLine | null {
  const m = FAIL.exec(line);
  return m ? { group: m[2].trim(), proc: m[3] ?? '', host: m[4], error: m[6] } : null;
}
// 内核的英文报错翻成一句话
export function failReason(err: string): string {
  if (/timeout|deadline exceeded/i.test(err)) return '连接超时';
  if (/refused/i.test(err)) return '连接被拒绝';
  if (/reset|EOF|closed|broken pipe|aborted/i.test(err)) return '连接被断开';
  if (/no such host|lookup/i.test(err)) return '域名解析失败';
  if (/auth|username\/password/i.test(err)) return '独享 IP 验证没通过';
  return err.length > 80 ? err.slice(0, 80) + '…' : err;
}

export function classify(c: ConnLine): AnomalyKind | null {
  if (SELF.test(c.proc)) return null;
  if (c.group === AI_GATE && c.node === 'REJECT') return 'blocked';
  if (isAiHost(c.host) && c.group !== AI_GATE && c.group !== AI_GROUP && c.node !== 'REJECT') return 'leak';
  return null;
}

// 连接日志里哪些算异常事件(第 1 层)
const BAD_KINDS = new Set(['意外断开', '连接失败', '拦截 AI', '禁止访问', '到期提醒']);
export const isAbnormalEvent = (e: LogEntry): boolean =>
  BAD_KINDS.has(e.kind) || /被改回|不一致|不是独享|没成功|到期|流量用完/.test(e.text);

const KEEP = 2000;
const WINDOW = 60_000;

export function createAnomalyLog(dir: string, now: () => number = Date.now) {
  const file = join(dir, 'anomalies.jsonl');
  let list: Anomaly[] = [];
  try {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > KEEP) writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n');
      list = lines.slice(-200).map((l) => { try { return JSON.parse(l) as Anomaly; } catch { return null; } }).filter((x): x is Anomaly => !!x);
    }
  } catch { /* 读不了就从空的开始 */ }
  // 还在一分钟窗口里、没写盘的
  const open = new Map<string, Anomaly>();
  let onFlush: ((a: Anomaly[]) => void) | null = null;
  // 发现 AI 连接没走独享 IP 的那一刻(每个程序+网站一分钟内只叫一次),用来马上拦住 AI(PM 10-20)
  let onLeak: ((a: Anomaly) => void) | null = null;

  function flush(force = false): void {
    const done: Anomaly[] = [];
    for (const [k, a] of open) if (force || now() - Date.parse(a.at) >= WINDOW) { done.push(a); open.delete(k); }
    if (!done.length) return;
    list = [...list, ...done].slice(-200);
    try { appendFileSync(file, done.map((a) => JSON.stringify(a)).join('\n') + '\n'); } catch { /* 写不了不影响连接 */ }
    onFlush?.(done);
  }

  function add(kind: AnomalyKind, proc: string, host: string, why: string): void {
    const k = `${kind}|${proc}|${host}`;
    const t = new Date(now()).toISOString();
    const hit = open.get(k);
    if (hit) { hit.count++; hit.last = t; return; }
    const a: Anomaly = { at: t, last: t, kind, proc, host, count: 1, reason: why };
    open.set(k, a);
    if (kind === 'leak') onLeak?.(a);
  }

  return {
    file,
    // 网络组件每输出一行就喂进来;reason:当时 AI 被拦的原因。null = 刚连上、防护还在检测(这时先拦着是正常的,不记)
    feed(line: string, reason: string | null): void {
      const f = parseFailLine(line);
      if (f) {
        if (f.group !== AI_GATE || SELF.test(f.proc)) return;
        add('failed', f.proc || '未知程序', f.host, failReason(f.error));
        return;
      }
      const c = parseConnLine(line);
      if (!c) return;
      const kind = classify(c);
      if (!kind || (kind === 'blocked' && reason === null)) return;
      add(kind, c.proc || '未知程序', c.host, kind === 'blocked' ? reason ?? '' : (c.node === 'DIRECT' ? '直连出去了' : `走了普通节点「${c.node}」`));
    },
    flush,
    onFlush(fn: (a: Anomaly[]) => void): void { onFlush = fn; },
    onLeak(fn: (a: Anomaly) => void): void { onLeak = fn; },
    // 最近的(包括还在窗口里的),新的在前
    recent(): Anomaly[] { return [...list, ...open.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 100); },
    text(): string {
      flush(true);
      let lines: string[] = [];
      try { lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []; } catch { /* 空 */ }
      return lines.map((l) => { try { return describe(JSON.parse(l) as Anomaly, true); } catch { return l; } }).join('\r\n');
    },
  };
}

export function describe(a: Anomaly, withTime = false): string {
  const time = withTime ? `${new Date(a.at).toLocaleString('zh-CN', { hour12: false })}  ` : '';
  const what = a.kind === 'blocked' ? `被拦住${a.reason ? `(${a.reason})` : ''}` : a.kind === 'failed' ? `连不上(${a.reason})` : `没走独享 IP:${a.reason}`;
  return `${time}${a.proc} → ${a.host} ${what}${a.count > 1 ? `,共 ${a.count} 次` : ''}`;
}

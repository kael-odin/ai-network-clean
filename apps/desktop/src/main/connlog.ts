// 连接日志(PM 10-18:留证据,用户说「用不了」时能对得上):每次连接、断开、独享 IP 断了又好了、出口验证的结果,
// 按时间写进用户数据目录的 connection-log.jsonl,一行一条,只留最近 5000 条。不含密码和订阅令牌;出口 IP 是用户自己的独享 IP
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LogEntry } from '../shared/ipc.ts';
export type { LogEntry };

const KEEP = 5000;

export function createConnLog(dir: string) {
  const file = join(dir, 'connection-log.jsonl');
  let recent: LogEntry[] = [];
  try {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > KEEP) writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n');
      recent = lines.slice(-100).map((l) => { try { return JSON.parse(l) as LogEntry; } catch { return null; } }).filter((x): x is LogEntry => !!x);
    }
  } catch { /* 读不了就从空的开始 */ }
  return {
    file,
    add(kind: string, text: string): LogEntry {
      const e = { at: new Date().toISOString(), kind, text };
      recent = [...recent, e].slice(-100);
      try { appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* 写不了不影响连接 */ }
      return e;
    },
    recent: () => recent,
    // 文件里的全部(最多 5000 条),异常事件列表启动时从这里筛
    all(): LogEntry[] {
      try { return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as LogEntry; } catch { return null; } }).filter((x): x is LogEntry => !!x) : []; } catch { return []; }
    },
    // 导出成人能看的文本:本地时间 + 类型 + 内容
    text(): string {
      let lines: string[] = [];
      try { lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []; } catch { /* 空 */ }
      return lines.map((l) => { try { const e = JSON.parse(l) as LogEntry; return `${new Date(e.at).toLocaleString('zh-CN', { hour12: false })}  [${e.kind}]  ${e.text}`; } catch { return l; } }).join('\r\n');
    },
  };
}

// 连接日志(PM 10-18:留证据,用户说「用不了」时能对得上):每次连接、断开、独享 IP 断了又好了、出口验证的结果,
// 按时间写进用户数据目录的 connection-log.jsonl,一行一条,只留最近 5000 条。不含密码和订阅令牌;出口 IP 是用户自己的独享 IP
//
// 长期开着时的改法:内存里留一份最近 5000 条,all()/text() 不再每次把文件整个读一遍
// (以前每轮检测都读 5000 行,读盘 + JSON.parse 全在主进程里);写盘改成异步追加
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LogEntry } from '../shared/ipc.ts';
export type { LogEntry };

const KEEP = 5000;
const RECENT = 100;

export function createConnLog(dir: string) {
  const file = join(dir, 'connection-log.jsonl');
  // 全量只在启动时读一次;之后都在内存里维护
  let all: LogEntry[] = [];
  try {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > KEEP) writeFileSync(file, lines.slice(-KEEP).join('\n') + '\n');
      all = lines.slice(-KEEP).map((l) => { try { return JSON.parse(l) as LogEntry; } catch { return null; } }).filter((x): x is LogEntry => !!x);
    }
  } catch { /* 读不了就从空的开始 */ }
  let recent: LogEntry[] = all.slice(-RECENT);
  return {
    file,
    add(kind: string, text: string): LogEntry {
      const e = { at: new Date().toISOString(), kind, text };
      recent = [...recent, e].slice(-RECENT);
      all = [...all, e];
      if (all.length > KEEP * 1.2) {
        // 攒到 1.2 倍再整体截断:不用每写一条就 slice 一次 5000 元素的数组
        all = all.slice(-KEEP);
        try { writeFileSync(file, all.map((x) => JSON.stringify(x)).join('\n') + '\n'); } catch { /* 写不了不影响连接 */ }
      } else {
        try { appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* 写不了不影响连接 */ }
      }
      return e;
    },
    recent: () => recent,
    // 内存里的全部(最多 5000 条);不再读盘
    all(): LogEntry[] { return all; },
    // 导出成人能看的文本:本地时间 + 类型 + 内容
    text(): string {
      return all.map((e) => { try { return `${new Date(e.at).toLocaleString('zh-CN', { hour12: false })}  [${e.kind}]  ${e.text}`; } catch { return JSON.stringify(e); } }).join('\r\n');
    },
  };
}

import type { AinApi } from '../shared/ipc.ts';

declare global {
  interface Window { ain: AinApi }
}

export const ain: AinApi = window.ain;

export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const fmtAgo = (iso: string | null | undefined): string => {
  if (!iso) return '-';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
};

export const fmtBytes = (n: number): string => {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

export const statePill = (s: 'ok' | 'fail' | 'unknown' | 'warn' | 'skip' | undefined): { cls: string; text: string } => {
  switch (s) {
    case 'ok': return { cls: 'ok', text: '正常' };
    case 'fail': return { cls: 'bad', text: '异常' };
    case 'warn': return { cls: 'warn', text: '提示' };
    case 'skip': return { cls: 'unknown', text: '未测' };
    default: return { cls: 'unknown', text: '未确认' };
  }
};

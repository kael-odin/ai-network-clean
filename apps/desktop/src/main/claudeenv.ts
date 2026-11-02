// 环境一致性核验(参考 CCBaga 的思路):出口 IP 的国家,应该和本机时区、系统语言对得上。
// "IP 在美国、时区是北京、语言是 zh-CN" 这种低级矛盾本身就是风控信号。
// 只做提示,不参与 AI 闸门(它不是泄露,是"特征矛盾")。
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import type { EnvItem, EnvReport } from '../shared/ipc.ts';

// 常见国家 → 时区前缀 / 主语言
const EXPECT: Record<string, { tz: string[]; lang: string[] }> = {
  US: { tz: ['America/', 'Pacific/Honolulu'], lang: ['en'] },
  CA: { tz: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax'], lang: ['en', 'fr'] },
  JP: { tz: ['Asia/Tokyo'], lang: ['ja'] },
  KR: { tz: ['Asia/Seoul'], lang: ['ko'] },
  SG: { tz: ['Asia/Singapore'], lang: ['en', 'zh'] },
  HK: { tz: ['Asia/Hong_Kong'], lang: ['zh', 'en'] },
  TW: { tz: ['Asia/Taipei'], lang: ['zh'] },
  GB: { tz: ['Europe/London'], lang: ['en'] },
  DE: { tz: ['Europe/Berlin'], lang: ['de'] },
  NL: { tz: ['Europe/Amsterdam'], lang: ['nl'] },
  FR: { tz: ['Europe/Paris'], lang: ['fr'] },
  AU: { tz: ['Australia/'], lang: ['en'] },
  CN: { tz: ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Urumqi'], lang: ['zh'] },
};

export interface LocalEnv { tz: string; locale: string; lang: string; platform: string; cpus: number; arch: string }

export function localEnv(): LocalEnv {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || '';
  const locale = process.env.LC_ALL || process.env.LANG || '';
  // Windows 上 LANG 常常是空的:用 PowerShell 读系统区域(失败就当未知)
  return {
    tz,
    locale,
    lang: locale.split(/[._-]/)[0] || '',
    platform: `${process.platform} ${process.arch}`,
    cpus: cpus().length,
    arch: process.arch,
  };
}

function detectLangSync(): string {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSyncPs('(Get-Culture).TwoLetterISOLanguageName');
    return out.trim().toLowerCase();
  } catch { return ''; }
}

function execFileSyncPs(cmd: string): string {
  // 同步读一次系统区域:只在扫描时用,耗时 ~80ms
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + cmd], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
}

export function buildEnvReport(country: string | null, envIn?: LocalEnv): EnvReport {
  const env = envIn ?? { ...localEnv(), lang: detectLangSync() || 'en' };
  const items: EnvItem[] = [];
  const exp = country ? EXPECT[country] : null;
  const tzOk = exp ? exp.tz.some((p) => env.tz.startsWith(p) || env.tz === p) : null;
  items.push({
    key: 'tz',
    label: '时区',
    expected: exp ? `${country} 常用时区` : '出口国家未知',
    actual: env.tz || '未知',
    ok: tzOk,
    hint: tzOk === false ? '出口在别的国家、时区还是本地:浏览器和系统会把两边对不上' : undefined,
  });
  const langOk = exp ? exp.lang.includes(env.lang) : null;
  items.push({
    key: 'lang',
    label: '系统语言',
    expected: exp ? exp.lang.join(' / ') : '出口国家未知',
    actual: env.lang || '未知',
    ok: langOk,
    hint: langOk === false ? '语言和出口国家不一致,访问 AI 网站时容易形成矛盾特征' : undefined,
  });
  items.push({ key: 'platform', label: '平台', expected: '—', actual: env.platform, ok: null });
  items.push({ key: 'cores', label: 'CPU 核数', expected: '—', actual: env.cpus ? `${env.cpus} 核` : '—', ok: null });
  const known = items.filter((i) => i.ok !== null);
  const ok = known.length > 0 && known.every((i) => i.ok === true);
  return { at: new Date().toISOString(), country, ok, items };
}

// 让界面也能直接拿到本机时区(导入时就已经算好了)
export const localTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || '';

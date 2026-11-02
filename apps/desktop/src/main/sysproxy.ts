// Windows 系统代理(IE/WinINET 设置,Chrome、Edge、Electron 默认都跟着它)
// 两件事:
// 1) take/restore:本地代理模式下把系统代理指到本客户端,断开时还原(原设置存文件,崩溃后下次启动自动还原)
// 2) clearStaleSysProxy:Clash 退出时偶尔不清系统代理,端口没人听,浏览器连国内网站都打不开——清掉它
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

export interface SysProxy { enabled: boolean; server: string }

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REFRESH =
  "[void](Add-Type -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);' -Name WinInet -Namespace Ain -PassThru)::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0); " +
  '[void]([Ain.WinInet])::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)';

function ps(args: string[]): Promise<string> {
  return new Promise((ok) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => ok(String(stdout ?? '').trim())));
}

export async function readSysProxy(): Promise<SysProxy> {
  if (process.platform !== 'win32') return { enabled: false, server: '' };
  const out = await ps([`$p = Get-ItemProperty '${KEY}'; [string]$p.ProxyEnable + '|' + [string]$p.ProxyServer`]);
  const [en, server = ''] = out.split('|');
  return { enabled: en.trim() === '1', server: server.trim() };
}

// 代理地址是本机回环且端口没人听 → 残留
export async function isStaleLoopbackProxy(p: SysProxy): Promise<boolean> {
  if (!p.enabled || !p.server) return false;
  const m = p.server.match(/(?:^|=)(127\.0\.0\.1|localhost):(\d+)/);
  if (!m) return false;
  const port = Number(m[2]);
  const listening = await new Promise<boolean>((ok) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 800 });
    s.once('connect', () => { s.destroy(); ok(true); });
    s.once('error', () => ok(false));
    s.once('timeout', () => { s.destroy(); ok(false); });
  });
  return !listening;
}

export async function disableSysProxy(): Promise<void> {
  if (process.platform !== 'win32') return;
  await ps([`Set-ItemProperty '${KEY}' -Name ProxyEnable -Value 0; ${REFRESH}`]);
}

// 有残留就清掉,返回清掉的地址
export async function clearStaleSysProxy(): Promise<string | null> {
  const p = await readSysProxy();
  if (!(await isStaleLoopbackProxy(p))) return null;
  await disableSysProxy();
  return p.server;
}

// ---------- 接管 / 还原 ----------
// autoConfigUrl(PAC)也要一起接管:有 PAC 时 WinINET 可能绕过我们设的全局代理
interface Saved { at: string; enabled: boolean; server: string; override: string; autoConfigUrl: string; hadPac: boolean }

// 备份文件在用户目录里,普通权限的程序也能改;里面的值会拼进 PowerShell,读的时候逐项校验。
// 放宽到覆盖 Windows 合法写法:socks= 、http= 、[::1]:7890 、localhost 等(太严会把用户原来的代理直接丢掉)
const SAFE_SERVER = /^[A-Za-z0-9_.:=\-; \[\]]{0,300}$/;
const SAFE_OVERRIDE = /^[A-Za-z0-9_.*;<>\- ,:\[\]]{0,1000}$/;
const SAFE_PAC = /^(https?:\/\/[A-Za-z0-9_.:\/~%?=&+\-]{0,800}|file:\/\/[A-Za-z0-9_.:\/~%\\\-]{0,800})?$/i;
const q = (s: string) => s.replace(/'/g, "''");

function sanitize(raw: unknown): Saved | null {
  const o = raw as Partial<Saved> | null;
  if (!o || typeof o !== 'object') return null;
  const autoConfigUrl = typeof o.autoConfigUrl === 'string' && SAFE_PAC.test(o.autoConfigUrl) ? o.autoConfigUrl : '';
  return {
    at: typeof o.at === 'string' ? o.at : '',
    enabled: o.enabled === true,
    server: typeof o.server === 'string' && SAFE_SERVER.test(o.server) ? o.server : '',
    override: typeof o.override === 'string' && SAFE_OVERRIDE.test(o.override) ? o.override : '',
    autoConfigUrl,
    hadPac: o.hadPac === true || !!autoConfigUrl,
  };
}

export function createSysProxy(dir: string) {
  const file = join(dir, 'sysproxy-backup.json');
  let saved: Saved | null = null;
  try { saved = existsSync(file) ? sanitize(JSON.parse(readFileSync(file, 'utf8'))) : null; } catch { saved = null; }

  const apply = (enabled: boolean, server: string, override: string, pac: string | null) =>
    ps([
      `Set-ItemProperty '${KEY}' -Name ProxyEnable -Value ${enabled ? 1 : 0}; ` +
      `Set-ItemProperty '${KEY}' -Name ProxyServer -Value '${q(server)}'; ` +
      `Set-ItemProperty '${KEY}' -Name ProxyOverride -Value '${q(override)}'; ` +
      // 有 PAC 时 WinINET 可能绕过全局代理:接管期间清掉,还原时写回;原来没有就删掉这个值,不改成空字符串
      (pac === null
        ? `Remove-ItemProperty '${KEY}' -Name AutoConfigURL -ErrorAction SilentlyContinue; `
        : `Set-ItemProperty '${KEY}' -Name AutoConfigURL -Value '${q(pac)}' -ErrorAction SilentlyContinue; `) +
      `${REFRESH}`,
    ]);

  return {
    pending: () => !!saved,
    // 把系统代理指到本客户端的端口
    async take(port: number): Promise<boolean> {
      if (process.platform !== 'win32') return false;
      if (!saved) {
        const cur = await readSysProxy();
        const raw = await ps([`$p = Get-ItemProperty '${KEY}'; [string]$p.ProxyOverride + '|' + [string]$p.AutoConfigURL`]);
        const [ov, pac = ''] = raw.split('|');
        saved = sanitize({ at: new Date().toISOString(), enabled: cur.enabled, server: cur.server, override: ov ?? '', autoConfigUrl: pac, hadPac: !!pac.trim() }) ?? { at: new Date().toISOString(), enabled: false, server: '', override: '', autoConfigUrl: '', hadPac: false };
        try { writeFileSync(file, JSON.stringify(saved)); } catch { /* 写不了就只影响崩溃恢复 */ }
      }
      await apply(true, `127.0.0.1:${port}`, '<local>;localhost;127.*', '');
      return true;
    },
    // 现在系统代理是不是指向我们
    async pointsTo(port: number): Promise<boolean> {
      if (process.platform !== 'win32') return false;
      const cur = await readSysProxy();
      if (!cur.enabled || !cur.server.includes(':' + port)) return false;
      // 有 PAC 在就会绕过我们的全局代理
      const pac = await ps([`$p = Get-ItemProperty '${KEY}'; [string]$p.AutoConfigURL`]);
      return !pac.trim();
    },
    // 还原成接管前的设置
    async restore(): Promise<void> {
      if (process.platform !== 'win32') return;
      if (!saved) { try { if (existsSync(file)) unlinkSync(file); } catch { /* 没有 */ } return; }
      const s = saved;
      saved = null;
      try { unlinkSync(file); } catch { /* 已经没了 */ }
      // 原来是自动配置(PAC 在、ProxyEnable 关)就按原样还原,不要自作主张把它打开
      await apply(s.enabled, s.server, s.override || '<local>', s.hadPac ? s.autoConfigUrl : null);
    },
  };
}
export type SysProxyManager = ReturnType<typeof createSysProxy>;

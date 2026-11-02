// 从客户端启动 Claude(全链路):把代理环境变量直接给到子进程,或者用内置窗口把网页版接管。
// 这是"子进程绕过系统代理"的正解:桌面版从我们这里启动时,它的渲染进程和子进程都继承我们设的代理环境。
import { BrowserWindow, session, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LaunchKind, LaunchResult } from '../shared/ipc.ts';
import { fingerprintScript } from './fingerprint.ts';

const run = (file: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((ok) => execFile(file, args, { windowsHide: true, timeout: 8000 }, (e, out) => ok({ ok: !e, out: String(out ?? '') })));

function proxyEnv(port: number): Record<string, string> {
  const p = `http://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: p,
    HTTPS_PROXY: p,
    ALL_PROXY: p,
    http_proxy: p,
    https_proxy: p,
    all_proxy: p,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
  };
}

// Claude Code:新开一个终端,环境里带好代理,再执行 claude
export async function launchClaudeCode(port: number): Promise<LaunchResult> {
  const env = { ...process.env, ...proxyEnv(port) };
  const probe = await run('where', ['claude']);
  const hasCli = probe.ok && probe.out.trim().length > 0;
  const cmd = hasCli ? 'claude' : 'claude';
  // 偏好 Windows Terminal,没有就退回 conhost
  const wt = await run('where', ['wt.exe']);
  try {
    if (wt.ok) {
      spawn('wt.exe', ['-w', '0', 'new-tab', '--title', 'Claude Code', 'cmd.exe', '/k', cmd], { env, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', cmd], { env, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    }
    return {
      ok: true,
      kind: 'code',
      detail: hasCli
        ? `已开新终端运行 Claude Code(代理 http://127.0.0.1:${port})`
        : `没找到 claude 命令,已开好带代理的终端;先安装 Claude Code 再在里面执行 claude`,
    };
  } catch (e) {
    return { ok: false, kind: 'code', detail: '启动失败:' + (e as Error).message };
  }
}

// Claude 桌面版:非商店版可以直接继承环境变量;商店版(MSIX)只能用 AppsFolder 拉起,环境变量给不进去
export async function launchClaudeDesktop(port: number): Promise<LaunchResult> {
  const env = { ...process.env, ...proxyEnv(port) };
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'AnthropicClaude', 'claude.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Claude', 'Claude.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Claude', 'Claude.exe'),
  ].filter((p) => p && existsSync(p));
  if (candidates[0]) {
    try {
      spawn(candidates[0], [], { env, detached: true, stdio: 'ignore' }).unref();
      return { ok: true, kind: 'desktop', detail: `已启动桌面版,并带上代理 http://127.0.0.1:${port}` };
    } catch (e) {
      return { ok: false, kind: 'desktop', detail: '启动失败:' + (e as Error).message };
    }
  }
  // 商店版:找包里的 AppId
  const appx = await run('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-AppxPackage *Claude* | Select-Object -First 1; if ($p) { $m = Get-AppxPackageManifest $p.PackageFullName; $id = $m.Package.Applications.Application.Id | Select-Object -First 1; $p.PackageFamilyName + '!' + $id }"]);
  const appId = appx.ok ? appx.out.trim() : '';
  if (appId) {
    try {
      await shell.openExternal(`shell:AppsFolder\\${appId}`);
      return {
        ok: true,
        kind: 'desktop',
        detail: '已通过应用商店入口启动。注意:商店版不继承我们的代理环境,桌面版里要走静态 IP 请用「虚拟网卡(TUN)」模式,或到设置里打开强制 TUN',
      };
    } catch (e) {
      return { ok: false, kind: 'desktop', detail: '启动失败:' + (e as Error).message };
    }
  }
  return { ok: false, kind: 'desktop', detail: '没找到已安装的 Claude 桌面版' };
}

// 网页版:内置窗口 + 独立会话,代理直接指到内核,和系统代理无关。
// 顺手把「时区/语言」调到出口国家(参考 CCBaga 的环境一致性):IP 在纽约、时区是北京 是最典型的矛盾特征。
const TZ_BY_COUNTRY: Record<string, string> = {
  US: 'America/New_York', CA: 'America/Toronto', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  SG: 'Asia/Singapore', HK: 'Asia/Hong_Kong', TW: 'Asia/Taipei', CN: 'Asia/Shanghai',
  GB: 'Europe/London', DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', FR: 'Europe/Paris', AU: 'Australia/Sydney',
};
const LOCALE_BY_COUNTRY: Record<string, string> = {
  US: 'en-US', CA: 'en-CA', JP: 'ja-JP', KR: 'ko-KR', SG: 'en-SG', HK: 'zh-HK', TW: 'zh-TW', CN: 'zh-CN',
  GB: 'en-GB', DE: 'de-DE', NL: 'nl-NL', FR: 'fr-FR', AU: 'en-AU',
};

let webWin: BrowserWindow | null = null;
export interface WebOptions {
  onLog?: (kind: string, text: string) => void;
  country?: string | null;
  followRegion?: boolean;
  fpNoise?: boolean;
  fpSeed?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 页面还没就绪时 attach/sendCommand 会一直等不到响应,所以:就绪后再调,并且加超时
async function applyRegion(wc: Electron.WebContents, country: string | null): Promise<string | null> {
  if (!country || wc.isDestroyed()) return null;
  const tz = TZ_BY_COUNTRY[country];
  const locale = LOCALE_BY_COUNTRY[country];
  if (!tz) return null;
  return Promise.race([
    (async () => {
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: tz });
        // Electron 里 Emulation.setLocaleOverride 不生效(navigator.language 还是系统语言),
        // 但 Accept-Language 会跟着 UA override 走——服务端看到的就是目标语言
        await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: wc.getUserAgent(),
          acceptLanguage: locale || 'en-US',
        });
        return `${tz}${locale ? ' / Accept-Language: ' + locale : ''}`;
      } catch { return null; }
    })(),
    sleep(3000).then(() => null),
  ]);
}

export async function openClaudeWeb(parent: BrowserWindow | null, port: number, opts: WebOptions = {}): Promise<LaunchResult> {
  const part = 'persist:claude-web';
  const s = session.fromPartition(part);
  await s.setProxy({ proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
  // 用普通的 Chrome UA(默认 UA 带 Electron,站点容易走不同分支)
  const chrome = process.versions.chrome ?? '152.0.7977.167';
  s.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`);
  if (webWin && !webWin.isDestroyed()) {
    webWin.show();
    webWin.focus();
    return { ok: true, kind: 'web', detail: 'Claude 网页窗口已经开着' };
  }
  webWin = new BrowserWindow({
    width: 1180, height: 820, parent: parent ?? undefined,
    title: 'Claude · 走静态 IP',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  webWin.on('closed', () => { webWin = null; });
  const follow = opts.followRegion !== false && !!opts.country && !!TZ_BY_COUNTRY[opts.country];
  const planned = follow ? `${TZ_BY_COUNTRY[opts.country!]}${LOCALE_BY_COUNTRY[opts.country!] ? ' / Accept-Language: ' + LOCALE_BY_COUNTRY[opts.country!] : ''}` : null;
  const wc = webWin.webContents;
  if (follow) {
    // 就绪后再套,且每次导航后重套(Emulation 挂在 target 上);全部异步,不阻塞调用方
    wc.once('dom-ready', () => { void applyRegion(wc, opts.country ?? null); });
    wc.on('did-navigate', () => { void applyRegion(wc, opts.country ?? null); });
  }
  if (opts.fpNoise) {
    // 指纹噪声必须在页面脚本之前注入:dom-ready 时装脚本 + 重载一次(只做一次)
    let injected = false;
    const inject = async (): Promise<void> => {
      if (injected) return;
      injected = true;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        // 顺序有讲究:必须先 Page.enable,否则 addScriptToEvaluateOnNewDocument 会静默不生效
        const step = async (method: string, params: Record<string, unknown> = {}) => {
          await Promise.race([wc.debugger.sendCommand(method, params), sleep(3000)]);
        };
        await step('Page.enable');
        await step('Page.addScriptToEvaluateOnNewDocument', { source: fingerprintScript(opts.fpSeed ?? 1) });
        wc.reload();
      } catch (e) {
        opts.onLog?.('指纹', '内置窗口的指纹噪声没能注入:' + (e as Error).message);
      }
    };
    wc.once('dom-ready', () => { void inject(); });
  }
  // 不等待加载:网络慢时 loadURL 会把调用方(界面按钮)卡住
  void webWin.loadURL('https://claude.ai/new').catch(() => {});
  return {
    ok: true, kind: 'web',
    detail: '已打开内置 Claude 窗口,流量全部经内核走静态 IP'
      + (planned ? `;时区/语言将按出口国家设为 ${planned}` : '')
      + (opts.fpNoise ? ';已开启 Canvas/WebGL 指纹噪声' : ''),
  };
}

export function closeClaudeWeb(): void {
  if (webWin && !webWin.isDestroyed()) webWin.close();
  webWin = null;
}

export type { LaunchKind };

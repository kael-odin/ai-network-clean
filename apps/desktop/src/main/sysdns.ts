// 堵 Windows 的 DNS 泄露(PM 10-19 实测:连着时本地运营商的 DNS 也查到了测试域名):
// Windows 会把域名查询同时发给所有网卡的 DNS,虚拟网卡这边被内核接管了,物理网卡(WLAN)上的运营商 DNS 也会收到一份,
// 而运营商 DNS 是局域网/直连地址,不经虚拟网卡。做法和 Clash Verge 一样:连着时把物理网卡的 DNS 临时改成内核在虚拟网卡上的 DNS,
// 这样查询都进虚拟网卡被接管;断开或退出时改回去。原来的设置记在文件里,客户端被强杀后下次启动自动恢复。
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

// 内核 TUN 的 DNS 地址(mihomo fake-ip 网段里的固定地址,dns-hijack any:53 会把进虚拟网卡的 53 端口查询都接住)
export const TUN_DNS = '198.18.0.2';
// IPv6 防泄露(PM 10-19):物理网卡的 IPv6 DNS(路由器通告的、运营商的)也会收到查询并给出真实 IPv6 地址。
// 有公网 IPv6 时把它也指到虚拟网卡 IPv6 网段里的地址(config.ts 的 inet6-address),查询进虚拟网卡被接管
export const TUN_DNS6 = 'fdfe:dcba:9876::2';

// static = 原来就是手工写死的 DNS,断开时写回;false = 原来是自动获取(DHCP),断开时只重置、不写回
// (PM 复查:Get-DnsClientServerAddress 在两种情况下都会返回地址,以前一律写回,笔记本换网络后 DNS 会写死成上一个路由器的)
interface SavedAdapter { guid: string; name: string; servers: string[]; servers6?: string[]; static: boolean }
interface Saved { at: string; adapters: SavedAdapter[]; ipv6?: boolean }

// 输出按 UTF-8:默认是系统代码页(GBK),中文网卡名(如「以太网 2」)读回来会乱码
export type Ps = (cmd: string) => Promise<string>;
const realPs: Ps = (cmd: string) => new Promise<string>((ok, bad) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + cmd], { windowsHide: true, timeout: 20_000 }, (e, stdout, stderr) => (e ? bad(new Error(String(stderr || e.message).trim())) : ok(String(stdout ?? '')))));

const target = (ipv6?: boolean) => (ipv6 ? `${TUN_DNS},${TUN_DNS6}` : TUN_DNS);

// 网卡用 InterfaceGuid 认,不用 ifIndex(重启、插拔之后编号会变,记下来的编号可能对到另一块网卡上)
// KeyName 去注册表里找「手工写死的 DNS」(NameServer),有它才算 static
const LIST_ADAPTERS = `Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Meta|Mihomo|Clash|TUN|TAP|WireGuard|Loopback|Hyper-V|VMware|VirtualBox|Bluetooth' } | ForEach-Object {
  $g = [string]$_.InterfaceGuid
  $s = (Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses -join ','
  $s6 = (Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue).ServerAddresses -join ','
  $ns = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$g" -Name NameServer -ErrorAction SilentlyContinue).NameServer
  $manual = @("$ns".Split(',') | Where-Object { $_ -and $_ -as [ipaddress] })
  "$g|$($_.Name)|$s|$s6|$($_.ifIndex)|$($manual.Count)"
}`;

const listAdapters = async (ps: Ps) => (await ps(LIST_ADAPTERS)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
  const [guid, name, servers, servers6, , manualCount] = l.split('|');
  // 读到的「原设置」里去掉客户端自己的地址:上次没改回去时读到的就是 198.18.0.2,记成原设置的话断开后整台电脑上不了网(PM 10-20 备份里出现过)
  const s4 = (servers ?? '').split(',').filter((x) => x && x !== TUN_DNS);
  const s6 = (servers6 ?? '').split(',').filter((x) => x && x !== TUN_DNS6);
  return {
    guid: (guid ?? '').toLowerCase(), name, servers: s4, servers6: s6,
    // 注册表里有手工配置的 DNS,断开时写回去;没有就是 DHCP 下发的,重置即可
    manual: s4.filter((x) => isIP(x) !== 0), static: Number(manualCount) > 0, current: servers ?? '',
  };
}).filter((a) => /^[0-9a-f-]{36}$/.test(a.guid));

export function sanitize(raw: unknown): Saved | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Saved).adapters)) return null;
  const r = raw as Saved;
  const ips = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isIP(x) !== 0) : []);
  const adapters = r.adapters
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      // 老备份只有 index 没有 guid:读的时候用不上,但字段形状要统一
      const guid = typeof a.guid === 'string' ? a.guid.toLowerCase() : '';
      return {
        guid, name: typeof a.name === 'string' ? a.name : guid,
        servers: ips(a.servers), servers6: ips(a.servers6),
        // 老备份没记 static:按「手工配置」处理,保住旧行为(写回),不会把用户原来的 DNS 弄丢
        static: a.static !== false,
      };
    })
    .filter((a) => /^[0-9a-f-]{36}$/.test(a.guid));
  return { at: typeof r.at === 'string' ? r.at : '', adapters, ipv6: r.ipv6 === true };
}

// 把一块网卡的 DNS 还原:原来是自动获取就只重置,原来是手工写死的再写回(IPv6 读到的多是路由器通告的,只重置不写回)
const restoreOne = (guid: string) =>
  `try { Set-DnsClientServerAddress -InterfaceGuid '${guid}' -ResetServerAddresses -ErrorAction SilentlyContinue } catch {}`;

export function createSysDns(dir: string, ps: Ps = realPs) {
  const win = ps !== realPs || process.platform === 'win32';
  const watching = { current: false };
  const file = join(dir, 'sysdns-backup.json');
  // 备份文件在用户目录里,普通权限的程序也能改;里面的值会拼进以管理员身份运行的 PowerShell 命令(PM 10-23 巡查:可被借来提权)。
  // 读的时候逐项校验:网卡编号必须是 GUID、DNS 必须是合法 IP,不合格的丢掉
  const load = (): Saved | null => { try { return existsSync(file) ? sanitize(JSON.parse(readFileSync(file, 'utf8'))) : null; } catch { return null; } };

  const applyOne = (a: { guid: string; static: boolean; servers: string[] }, ipv6?: boolean) =>
    a.static && a.servers.length
      ? `Set-DnsClientServerAddress -InterfaceGuid '${a.guid}' -ServerAddresses ${target(ipv6).split(',').concat(a.servers).join(',')}`
      : `Set-DnsClientServerAddress -InterfaceGuid '${a.guid}' -ServerAddresses ${target(ipv6)}`;

  // 看守进程用的还原脚本和 restore() 逻辑保持一致
  const restoreScript = (backupPath: string): string => [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$f = '${backupPath.replace(/'/g, "''")}'`,
    'if (Test-Path $f) {',
    '  $b = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json',
    '  foreach ($a in $b.adapters) {',
    "    if ($a.guid -notmatch '^[0-9a-fA-F-]{36}$') { continue }",
    '    try { Set-DnsClientServerAddress -InterfaceGuid $a.guid -ResetServerAddresses -ErrorAction SilentlyContinue } catch {}',
    "    $ok = @($a.servers | Where-Object { $_ -as [ipaddress] -and $_ -ne '" + TUN_DNS + "' })",
    '    if ($a.static -and $ok.Count -gt 0) { try { Set-DnsClientServerAddress -InterfaceGuid $a.guid -ServerAddresses $ok -ErrorAction SilentlyContinue } catch {} }',
    '  }',
    '  Remove-Item $f -Force',
    '  Clear-DnsClientCache',
    '}',
  ].join('\n');

  // 看守进程:用客户端自己的程序以 Node 方式运行(ELECTRON_RUN_AS_NODE),分离启动,客户端被结束也不受影响。
  // 不直接分离启动 PowerShell:没有控制台的 PowerShell 一启动就退出、什么也不做(10-23 实测,原来关机时的「后台改回」一直没生效)。
  // 看守进程每 2 秒看一次客户端还在不在,没了就(非分离地)跑一遍按备份改回 DNS 的 PowerShell
  function startWatcher(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const script = restoreScript(file);
    const watch = "const p=Number(process.env.AIN_WD_PID);const alive=()=>{try{process.kill(p,0);return true}catch(e){return e.code==='EPERM'}};"
      + "const t=setInterval(()=>{if(alive())return;clearInterval(t);setTimeout(()=>{require('child_process').spawnSync('powershell',['-NoProfile','-NonInteractive','-EncodedCommand',process.env.AIN_WD_PS],{windowsHide:true,timeout:60000});process.exit(0)},2000)},2000);";
    try {
      spawn(process.execPath, ['-e', watch], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIN_WD_PID: String(pid), AIN_WD_PS: Buffer.from(script, 'utf16le').toString('base64') },
        windowsHide: true, detached: true, stdio: 'ignore',
      }).unref();
      return true;
    } catch { return false; }
  }

  return {
    // 把除虚拟网卡以外、在线的物理网卡的 DNS 改成内核的;返回改了哪些网卡
    async apply(opts: { ipv6?: boolean } = {}): Promise<string[]> {
      if (!win) return [];
      // 已经改过(上次没改回去,或内核意外退出后自动重连时故意没改回):沿用记下的原设置,直接再指一次。
      // 不先改回:改回去那一下 AI 网站会从真实网络解析;也不重新读,否则会把内核地址当成「原来的设置」记下来
      const prev = load();
      if (prev) {
        for (const a of prev.adapters) await ps(applyOne(a, prev.ipv6)).catch(() => {});
        await ps('Clear-DnsClientCache').catch(() => {});
        return prev.adapters.map((a) => a.name);
      }
      const adapters = await listAdapters(ps);
      if (adapters.length === 0) return [];
      // 再指一次之前,再确认一遍这些网卡现在不是自动获取(注册表里没有手工 DNS 就记成 DHCP)
      const saved: Saved = {
        at: new Date().toISOString(), ipv6: !!opts.ipv6,
        adapters: adapters.map((a) => ({ guid: a.guid, name: a.name, servers: a.servers, servers6: a.servers6, static: a.static })),
      };
      writeFileSync(file, JSON.stringify(saved));
      for (const a of saved.adapters) await ps(applyOne(a, saved.ipv6));
      await ps('Clear-DnsClientCache').catch(() => {});
      return saved.adapters.map((a) => a.name);
    },
    // 改回原来的设置:原来是自动获取(DHCP)的就重置,原来写死的就写回
    async restore(): Promise<void> {
      const saved = load();
      if (!saved) return;
      for (const a of saved.adapters) {
        await ps(restoreOne(a.guid)).catch(() => {});
        // IPv6 的 DNS 只重置不写回:读到的多是路由器通告的(自动的),写回会变成写死的
        if (a.static && a.servers.length) await ps(`Set-DnsClientServerAddress -InterfaceGuid '${a.guid}' -ServerAddresses ${a.servers.join(',')}`).catch(() => {});
      }
      try { unlinkSync(file); } catch { /* 已经没了 */ }
      await ps('Clear-DnsClientCache').catch(() => {});
    },
    // 确认现在在线的物理网卡 DNS 全都指着客户端(PM 10-23:DNS 检测服务连不上时拿它当本机核对,要真读到才算,读不到算没确认)
    async confirm(): Promise<boolean> {
      if (!win) return false;
      const list = await listAdapters(ps);
      return list.length > 0 && list.every((a) => a.current === TUN_DNS);
    },
    // 核对物理网卡的 DNS 还指着客户端(PM 10-19 第二批):别的软件(VPN、安全软件、网卡驱动)可能把它改回去,查询就又从运营商那里漏出去。
    // 只看现在在线的网卡(PM 10-20:USB 无线网卡断开后它的 DNS 读出来是空的,被当成「改回去了」,每次检测都拦一次 AI):
    // - 记过的网卡被改了:重新设置,确实改回来了才算 reverted(这是真的被别的软件改了)
    // - 后来才连上的网卡(开机后 Wi-Fi 晚连上、插了网线):记下原设置并接管,算 added
    async verify(): Promise<{ reverted: string[]; added: string[] }> {
      const saved = load();
      if (!saved || !win) return { reverted: [], added: [] };
      const reverted: string[] = [];
      const added: string[] = [];
      for (const cur of await listAdapters(ps)) {
        const known = saved.adapters.find((x) => x.guid === cur.guid);
        if (cur.current === TUN_DNS) continue;
        await ps(known ? applyOne(known, saved.ipv6) : applyOne({ guid: cur.guid, static: cur.static, servers: cur.servers }, saved.ipv6)).catch(() => {});
        if (!known) { saved.adapters.push({ guid: cur.guid, name: cur.name, servers: cur.servers, servers6: cur.servers6, static: cur.static }); added.push(cur.name); continue; }
        const now = (await ps(`(Get-DnsClientServerAddress -InterfaceGuid '${cur.guid}' -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses -join ','`).catch(() => '')).trim();
        if (now === TUN_DNS) reverted.push(cur.name);
      }
      if (added.length) writeFileSync(file, JSON.stringify(saved));
      if (reverted.length || added.length) await ps('Clear-DnsClientCache').catch(() => {});
      return { reverted, added };
    },
    // 关机时用(PM 10-20:关机慢):不等改回,客户端马上退出;由看守进程等客户端退出后按备份改回。
    // 备份文件留着:要是关机太快没跑完,下次启动客户端还会再恢复一次(恢复是幂等的)
    restoreDetached(): void {
      if (!load() || !win) return;
      startWatcher(process.pid);
    },
    // 看守进程(PM 10-23 巡查):客户端被任务管理器结束或崩溃时,物理网卡的 DNS 还指着已经不在的内核,整台电脑上不了网,
    // 原来要等下次打开客户端才恢复。接管 DNS 时起一个看守进程,等客户端进程没了,备份文件还在就按它改回去;
    // 正常断开、退出时客户端自己会改回并删掉备份,它就什么也不做。每个客户端进程只起一个
    watchdog(pid: number): void {
      if (!win || watching.current) return;
      watching.current = startWatcher(pid);
    },
    pending: () => !!load(),
    flush: () => ps('Clear-DnsClientCache').then(() => {}),
  };
}

// 网络诊断:把「为什么连不上 / 为什么 AI 网站打不开」按顺序拆成几步,每步给出结论和建议
import { execFile } from 'node:child_process';
import type { Session } from 'electron';
import type { DiagReport, DiagStep } from '../shared/ipc.ts';
import { describeSub } from './sub.ts';
import type { Mihomo } from './mihomo.ts';

const SITES: [string, string][] = [
  ['claude.ai', 'Claude'],
  ['chatgpt.com', 'ChatGPT'],
  ['gemini.google.com', 'Gemini'],
];

export interface DiagnoseInput {
  mihomo: Mihomo;
  session: Session;
  expectedIp: string | null;
  hasIpv6: boolean;
  mode: 'tun' | 'proxy';
  otherTun: string | null;
  hasLine: boolean;
  lineReason: string | null;
  hasSubs: boolean;
}

function finish(steps: DiagStep[], advice: string[], sites: DiagReport['sites'] = []): DiagReport {
  const failed = steps.find((s) => s.state === 'fail');
  const summary = failed ? `${failed.title}:${failed.detail}` : steps.some((s) => s.state === 'warn') ? '基本正常,个别项有提示' : '一切正常';
  return { at: new Date().toISOString(), steps, summary, advice, sites };
}

const skip = (key: string, title: string): DiagStep => ({ key, title, state: 'skip', detail: '前面的步骤没通过,这一步没法测' });

export async function diagnose(o: DiagnoseInput): Promise<DiagReport> {
  const steps: DiagStep[] = [];
  const advice: string[] = [];

  if (!o.mihomo.running) {
    steps.push({ key: 'core', title: '网络组件', state: 'fail', detail: '还没有连接' });
    advice.push('在首页点「开启连接」');
    for (const [k, t] of [['sub', '你的节点'], ['line', '静态 IP 可用'], ['exit', '出口验证'], ['sites', 'AI 服务可达']]) steps.push(skip(k, t));
    return finish(steps, advice);
  }

  const pathText = o.hasLine
    ? (o.mihomo.hasLine ? 'AI 走你的静态 IP' : 'AI 走你的静态 IP')
    : 'AI 走你的订阅节点(还没填静态 IP)';
  steps.push({
    key: 'core', title: '网络组件', state: 'ok',
    detail: (o.mode === 'tun' ? '虚拟网卡接管' : `本地代理模式 127.0.0.1:${o.mihomo.mixedPort}`) + ' · ' + pathText,
  });
  if (o.mode === 'tun') steps.push(await checkRoutes(o.hasIpv6));
  if (o.otherTun) advice.push(`检测到「${o.otherTun}」在运行,AI 流量会先经过它;要完整接管请退出它再重新连接`);

  // 订阅
  if (o.hasSubs) {
    await o.mihomo.checkUserSub();
    const sub = await o.mihomo.userSubStatus();
    const bad = describeSub(sub);
    if (bad) {
      steps.push({ key: 'sub', title: '你的节点', state: 'fail', detail: bad });
      advice.push(sub.placeholders.length > 0 ? '到你的节点服务商续费或换一条有效的订阅,然后在「设置 → 节点订阅」更新,断开再连接' : '确认订阅链接是服务商给的 Clash 订阅地址');
      for (const [k, t] of [['line', '静态 IP 可用'], ['exit', '出口验证'], ['sites', 'AI 服务可达']]) steps.push(skip(k, t));
      return finish(steps, advice);
    }
    steps.push(sub.usable > 0
      ? { key: 'sub', title: '你的节点', state: 'ok', detail: `${sub.total} 个节点,${sub.usable} 个测通,当前用「${sub.now ?? ''}」` }
      : { key: 'sub', title: '你的节点', state: 'fail', detail: `${sub.total} 个节点都没有测通` });
    if (sub.usable === 0) {
      advice.push('你的节点都连不上:看看服务商有没有公告,或换一条订阅');
      for (const [k, t] of [['line', '静态 IP 可用'], ['exit', '出口验证'], ['sites', 'AI 服务可达']]) steps.push(skip(k, t));
      return finish(steps, advice);
    }
  }

  // 静态 IP
  if (o.hasLine) {
    await o.mihomo.checkGroup();
    const g = await o.mihomo.groupStatus().catch(() => null);
    if (g?.lineUp) {
      steps.push({ key: 'line', title: '静态 IP 可用', state: 'ok', detail: '健康检查通过' });
    } else {
      steps.push({
        key: 'line', title: '静态 IP 可用', state: 'fail',
        detail: '连不上静态 IP,AI 请求已阻断(不会改走其他线路)' + (o.lineReason ? '。原因:' + o.lineReason : ''),
      });
      if (o.lineReason) advice.push(o.lineReason);
      else {
        advice.push('静态 IP 直连不通时:在「设置 → 我的静态 IP」打开「经节点连接静态 IP」,或换一个节点');
        advice.push('也可以核对地址、端口、协议(SOCKS5 / HTTP)和账号密码');
      }
      steps.push(skip('exit', '出口验证'), skip('sites', 'AI 服务可达'));
      return finish(steps, advice);
    }
  } else {
    steps.push({ key: 'line', title: '静态 IP 可用', state: 'skip', detail: '还没填静态 IP,AI 走你的订阅节点' });
  }

  // 出口
  await o.session.setProxy({ proxyRules: `http=127.0.0.1:${o.mihomo.mixedPort};https=127.0.0.1:${o.mihomo.mixedPort}`, proxyBypassRules: '<-loopback>' });
  let exitOk = false;
  try {
    const r = await o.session.fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    const ip = (await r.text()).match(/^ip=(.+)$/m)?.[1]?.trim() ?? '';
    if (ip && (!o.expectedIp || ip === o.expectedIp)) {
      exitOk = true;
      steps.push({ key: 'exit', title: '出口验证', state: 'ok', detail: `出口 IP 是 ${ip}${o.expectedIp ? '(你的静态 IP)' : ''}` });
    } else if (ip) {
      steps.push({ key: 'exit', title: '出口验证', state: 'fail', detail: `出口 IP 是 ${ip},不是静态 IP ${o.expectedIp}` });
      advice.push('出口不对:确认静态 IP 那一条的地址/账号是对的,断开再连接;仍不对就是这条 IP 的背后出口变了');
    } else {
      steps.push({ key: 'exit', title: '出口验证', state: 'fail', detail: '没有读到出口 IP' });
    }
  } catch (e) {
    steps.push({ key: 'exit', title: '出口验证', state: 'fail', detail: '出口检测失败:' + (e as Error).message });
  }

  // 各站可达
  const { sites, results } = await checkSites(o.session);
  const bad = sites.filter((x) => !x.ok).length;
  steps.push({ key: 'sites', title: 'AI 服务可达', state: bad === 0 ? 'ok' : bad === SITES.length ? 'fail' : 'warn', detail: results.join(' · ') });
  if (bad && exitOk) advice.push('个别网站不通多半是临时的,稍后再试');
  return finish(steps, advice, sites);
}

// 各 AI 网站能不能打开(拿到任意 HTTP 应答就算可达,403 是网站拦非浏览器,不算失败)
export async function checkSites(session: Session): Promise<{ sites: { name: string; ok: boolean }[]; results: string[] }> {
  const out = await Promise.all(SITES.map(async ([host, name]) => {
    try {
      const r = await session.fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(15000), cache: 'no-store' });
      return { site: { name, ok: true }, text: `${name} ${r.status}` };
    } catch (e) {
      return { site: { name, ok: false }, text: `${name} 不通(${(e as Error).message.replace(/^TypeError: /, '')})` };
    }
  }));
  return { sites: out.map((x) => x.site), results: out.map((x) => x.text) };
}

const psRun = (cmd: string) => new Promise<string>((ok) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' + cmd], { windowsHide: true, timeout: 15_000 }, (_e, out) => ok(String(out ?? ''))));

// 虚拟网卡在不在,去外网的 IPv4、IPv6 路由是不是都指向它
export async function checkRoutes(hasIpv6: boolean): Promise<DiagStep> {
  if (process.platform !== 'win32') return { key: 'route', title: '虚拟网卡和路由', state: 'skip', detail: '只在 Windows 上检查' };
  const out = (await psRun("$a = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Meta|Mihomo' -or $_.Name -eq 'Meta' } | Select-Object -First 1; " +
    "$r4 = (Find-NetRoute -RemoteIPAddress 1.1.1.1 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias | Select-Object -First 1).InterfaceAlias; " +
    "$r6 = (Find-NetRoute -RemoteIPAddress 2606:4700:4700::1111 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias | Select-Object -First 1).InterfaceAlias; " +
    '"$($a.Name)|$($a.Status)|$r4|$r6"')).trim();
  const [name, status, r4, r6] = out.split('|');
  const title = '虚拟网卡和路由';
  if (!name) return { key: 'route', title, state: 'fail', detail: '找不到虚拟网卡:浏览器和桌面程序的流量没有被接管' };
  if (status && status !== 'Up') return { key: 'route', title, state: 'fail', detail: `虚拟网卡「${name}」状态是 ${status}` };
  if (r4 !== name) return { key: 'route', title, state: 'fail', detail: `去外网的 IPv4 流量走的是「${r4 || '没有路由'}」,不是虚拟网卡` };
  if (hasIpv6 && r6 && r6 !== name) return { key: 'route', title, state: 'fail', detail: `去外网的 IPv6 流量走的是「${r6}」,不是虚拟网卡(IPv6 会绕过客户端)` };
  return { key: 'route', title, state: 'ok', detail: `虚拟网卡「${name}」在用;IPv4${hasIpv6 ? '、IPv6' : ''} 去外网都走它${hasIpv6 ? '' : '(这台电脑没有公网 IPv6)'}` };
}

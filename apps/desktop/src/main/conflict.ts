// TUN 模式能不能起,只看一件事:有没有别的隧道网卡已经在线、并且占着默认路由。
// 光是 Clash 之类进程在跑、但它的 TUN 开关关着,不会和我们的 TUN 抢地址或路由——可以照常起。
// 这里把"判定"和"检测"分开:判定是纯函数,可以离线测试;检测要调 PowerShell,留在主进程里。
import type { TunMode } from '../shared/ipc.ts';

export const PROXY_PROCESSES = /^(clash-verge|verge-mihomo|verge-mihomo-alpha|clash|Clash for Windows|clash-win64|clashn|mihomo|sing-box|v2rayn|v2ray|xray|netch|nekobox|nekoray|hiddify|flclash|Surge)$/i;
export const PROXY_ADAPTER = /Meta|Mihomo|Clash|sing-box|Surge|Netch|v2ray|Xray/i;
export const VPN_ADAPTER = /\bTUN\b|TAP-|WireGuard|Tailscale|ZeroTier|VPN|Hamachi|Oray|Wintun/i;
// 默认路由上的"隧道类"网卡才算外部 TUN(物理网卡占默认路由是正常的)
const TUNNEL = /Meta|Mihomo|Clash|TUN|wintun|TAP-|WireGuard|Tailscale|ZeroTier|Wireguard|OpenVPN|Hamachi|VPN/i;

export function isTunnelAdapter(name: string, desc: string): boolean {
  return TUNNEL.test(`${name} ${desc}`);
}

export interface TunDecision { tun: boolean; warning: string | null; mode: 'tun' | 'proxy' }

// otherAdapter:别的隧道网卡占着默认路由的名字(没有就是 null)——这是唯一真正挡住 TUN 的情形
// proxyProcs:在跑的代理类进程名(只是提示用,不挡 TUN)
export function decideTun(tun: TunMode, admin: boolean, otherAdapter: string | null, proxyProcs: string[], mixedPort: number): TunDecision {
  if (otherAdapter) {
    return { tun: false, mode: 'proxy', warning: `检测到「${otherAdapter}」在接管全局流量:已改用本地代理模式,要完整接管请退出它再重新连接` };
  }
  if (!admin) {
    return { tun: false, mode: 'proxy', warning: `没有管理员权限:本地代理模式,只接管浏览器(系统代理已指到 127.0.0.1:${mixedPort}),桌面程序接管不了` };
  }
  const want = tun !== 'off';
  if (!want) {
    return { tun: false, mode: 'proxy', warning: proxyProcs.length ? `本地代理模式。${proxyProcs.join('、')} 在运行但没接管流量,不影响;要完整接管可到「设置」打开虚拟网卡` : null };
  }
  // 要起 TUN。有代理进程在跑但没接管流量:照常起,只提醒一句(它之后开了 TUN,客户端会自动降级)
  const note = proxyProcs.length ? `虚拟网卡模式。${proxyProcs.join('、')} 在运行但没接管流量,不影响;若它之后开了 TUN,客户端会自动降级到本地代理` : null;
  return { tun: true, mode: 'tun', warning: note };
}

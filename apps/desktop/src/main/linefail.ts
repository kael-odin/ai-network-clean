// 静态 IP 连不上时说清原因:从内核日志里经 AI 出口组拨号失败的那些行判断
// (节点不肯转发、静态 IP 拒绝连接、账号密码不对、超时、域名解析不出来)。只看最近 2 分钟,取出现最多的那种
import { AI_GROUP } from './config.ts';

export type FailCode = 'relay_refused' | 'front_down' | 'auth' | 'refused' | 'timeout' | 'dns';

// 内核报错原文 → 哪一种。顺序有讲究:先认更具体的
export function classify(error: string): FailCode | null {
  if (/auth|username|password|\b407\b/i.test(error)) return 'auth';
  // 「静态 IP 地址 connect error: 节点地址 connect error: …」:去静态 IP 的那个节点自己连不上
  if (/connect error: \S+ connect error:/i.test(error)) return 'front_down';
  if (/no such host|resolve|couldn't find ip|lookup .* failed/i.test(error)) return 'dns';
  if (/refused|积极拒绝/i.test(error)) return 'refused';
  if (/\bEOF\b|ws closed|connection reset|forcibly closed|强迫关闭/i.test(error)) return 'relay_refused';
  if (/i\/o timeout|deadline exceeded|timed out|failed to respond/i.test(error)) return 'timeout';
  return null;
}

// 给用户看的一句话。viaNode = 先经订阅节点再到静态 IP
export function reasonText(code: FailCode, viaNode: boolean): string {
  switch (code) {
    case 'relay_refused':
      return viaNode
        ? '你的节点接了连接又马上断开:多半是这家节点服务商不肯转发到你的静态 IP(有的会限制端口),也可能是协议(SOCKS5 / HTTP)选错了。先在「节点」页换一个节点;都不行就在设置里换一家订阅'
        : '静态 IP 的服务器接了连接又马上断开:协议(SOCKS5 / HTTP)可能选错了,或者这条 IP 暂时不可用';
    case 'front_down':
      return '去静态 IP 的那个节点自己连不上:在「节点」页换一个节点试试';
    case 'auth':
      return '静态 IP 的账号或密码不对:到「设置 → 我的静态 IP」核对一下';
    case 'refused':
      return '静态 IP 的服务器拒绝连接:端口或协议(SOCKS5 / HTTP)可能填错了,也可能这条 IP 做了来源限制(IP 白名单里没有你现在的出口)';
    case 'timeout':
      return viaNode
        ? '连静态 IP 超时:这条 IP 可能已过期或暂时不可用,也可能是你的节点太慢。先换一个节点试试'
        : '连静态 IP 超时:你的网络可能直连不了它(大陆网络通常如此)。在设置里打开「经节点连接静态 IP」再试';
    case 'dns':
      return '静态 IP 的地址解析不出来:检查地址是否填对';
  }
}

const WINDOW_MS = 2 * 60_000;

export function createLineFail(now: () => number = Date.now) {
  let seen: { at: number; code: FailCode }[] = [];
  return {
    // 内核日志一行:只认经 AI 出口组拨号失败的([TCP] dial AI 专用出口 (match …) … --> host:443 error: …)
    feed(line: string): void {
      if (!line.includes(`dial ${AI_GROUP}`)) return;
      const error = line.match(/ error: (.*?)"?$/)?.[1] ?? '';
      const code = classify(error);
      if (!code) return;
      const t = now();
      seen = [...seen.filter((x) => t - x.at < WINDOW_MS), { at: t, code }].slice(-200);
    },
    reset(): void { seen = []; },
    reason(): FailCode | null {
      const t = now();
      const counts = new Map<FailCode, number>();
      for (const x of seen) if (t - x.at < WINDOW_MS) counts.set(x.code, (counts.get(x.code) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    },
  };
}

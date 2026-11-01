// 用户机场订阅里的节点分类:机场在订阅到期、流量用完时会返回几条「提示节点」(名字是提示语,服务器指向 1.1.1.1:1080 之类),
// 不是真节点。按名字识别它们,好给用户一句明白的提示,而不是笼统的「独享 IP 不可用」
// 真节点名里也可能带「网址」「官网」之类(狗狗加速:「🌏自动最优线路(hy2)-网址: new.dg6.me」),所以只认明确的到期/续费字样,
// 并且名字里带协议标记或地区旗帜的一律当真节点
const PLACEHOLDER_RE = /到期|过期|流量用完|流量已用|剩余流量|续费|套餐|重置|有效期|请更新|订阅链接|^❗|expire|expired|traffic|renew/i;
const REAL_HINT_RE = /\((hy2|hysteria2?|anytls|vmess|vless|trojan|ss|tuic|reality)\)|[\u{1F1E6}-\u{1F1FF}]{2}/iu;

export function isPlaceholderNode(name: string): boolean {
  return PLACEHOLDER_RE.test(name) && !REAL_HINT_RE.test(name);
}

import type { SubSummary } from '../shared/ipc.ts';
export type { SubSummary };

// 订阅还没拉到 / 拉到了但只有提示节点 / 正常,三种情况给不同的话
export function describeSub(s: SubSummary): string | null {
  if (s.total === 0 && s.placeholders.length > 0) return `订阅里没有可用节点,节点服务商返回的是:${s.placeholders.slice(0, 3).join(' / ')}。多半是订阅已到期或流量用完,请续费后更新订阅链接再连接`;
  if (s.total === 0) return '订阅里没有节点:检查订阅链接是否正确(Clash 订阅和通用订阅都可以),或稍后再试';
  return null;
}

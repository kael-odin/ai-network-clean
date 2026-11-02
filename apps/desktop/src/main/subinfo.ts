// 读用户订阅里除节点之外我们还需要的东西:DNS 策略和 hosts。
// 机场的节点域名常常只能用机场自己的 DoH 解析(狗狗加速:+.quandao.com → https://api-d.dohcore.com:2096/dns-query/<token>),
// 公共 DNS 查到的是假地址(overdue.aliyun.com → 170.33.12.185),节点全连不上。Clash 用整份订阅所以没事,
// 我们只把订阅当节点集用就会丢掉这段,必须自己拉一次订阅把它合进配置(PM 实测 61 个节点全超时的根因)
import { load } from 'js-yaml';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isPlaceholderNode } from './sub.ts';
import { join } from 'node:path';

export interface SubDns {
  nameserverPolicy: Record<string, string | string[]>;
  hosts: Record<string, unknown>;
  // 订阅正文已经写进内核的节点集文件(proxies/user-sub.yaml):内核启动时直接读它,不用自己再拉
  prefilled?: boolean;
}

// 订阅正文里有真节点(不只是「到期/续费」提示节点)才算能用
export function hasRealNodes(text: string): boolean {
  let doc: unknown;
  try { doc = load(text); } catch { return false; }
  const proxies = (doc as { proxies?: { name?: unknown }[] } | null)?.proxies;
  return Array.isArray(proxies) && proxies.some((p) => typeof p?.name === 'string' && !isPlaceholderNode(p.name));
}

const EMPTY: SubDns = { nameserverPolicy: {}, hosts: {} };

// 从订阅正文里取 dns.nameserver-policy 和 hosts;不是 YAML(base64 节点列表等)就当没有
export function parseSubDns(text: string): SubDns {
  let doc: unknown;
  try { doc = load(text); } catch { return EMPTY; }
  if (!doc || typeof doc !== 'object') return EMPTY;
  const d = doc as { dns?: { 'nameserver-policy'?: unknown }; hosts?: unknown };
  const policy = d.dns?.['nameserver-policy'];
  const hosts = d.hosts;
  return {
    nameserverPolicy: policy && typeof policy === 'object' && !Array.isArray(policy) ? (policy as Record<string, string | string[]>) : {},
    hosts: hosts && typeof hosts === 'object' && !Array.isArray(hosts) ? (hosts as Record<string, unknown>) : {},
  };
}

// 拉订阅(用和内核一样的 UA,机场按 UA 给 Clash 格式),成功就缓存;拉不到用上次缓存。
// 有真节点的正文同时写成内核的节点集文件:刚退出 Clash 那几秒内核自己的 DNS 常常还不通,拉订阅失败就报「订阅里没有节点」
//(PM 10-18 实测:内核解析订阅域名超时,客户端自己这次是拉到了的)。没拉到就用上次拉到的真节点
// id:节点服务商的编号(多个服务商各有一套缓存,节点集文件名和 config.ts 的 subProvider 一致)
export async function fetchSubDns(url: string, cacheDir: string, id: string, coreVersion = 'v1.19.32'): Promise<SubDns> {
  const file = join(cacheDir, `sub-dns-${id}.json`);
  const body = join(cacheDir, `sub-body-${id}.yaml`);
  const target = join(cacheDir, 'proxies', `user-sub-${id}.yaml`);
  mkdirSync(join(cacheDir, 'proxies'), { recursive: true });
  try {
    const r = await fetch(url, { headers: { 'user-agent': `mihomo/${coreVersion}` }, signal: AbortSignal.timeout(20_000), redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    const info = parseSubDns(text);
    writeFileSync(file, JSON.stringify({ url, ...info }));
    if (!hasRealNodes(text)) return info;
    writeFileSync(body, text);
    writeFileSync(target, text);
    return { ...info, prefilled: true };
  } catch {
    try {
      if (existsSync(file)) {
        const c = JSON.parse(readFileSync(file, 'utf8')) as SubDns & { url: string };
        if (c.url === url) {
          const prefilled = existsSync(body);
          if (prefilled) copyFileSync(body, target);
          return { nameserverPolicy: c.nameserverPolicy ?? {}, hosts: c.hosts ?? {}, prefilled };
        }
      }
    } catch { /* 缓存坏了就当没有 */ }
    return EMPTY;
  }
}

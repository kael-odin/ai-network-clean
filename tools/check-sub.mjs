// 检查订阅:能不能拉、有几个节点、有没有 dns/hosts(不打印链接本身,避免带令牌进日志)
import { load } from 'js-yaml';

const url = process.argv[2];
const r = await fetch(url, { headers: { 'user-agent': 'mihomo/v1.19.32' }, signal: AbortSignal.timeout(25_000), redirect: 'follow' });
console.log('HTTP', r.status, r.headers.get('content-type'), 'bytes:', (await r.clone().text()).length);
if (!r.ok) process.exit(1);
const text = await r.text();
const doc = load(text);
const proxies = doc?.proxies ?? [];
console.log('节点数:', proxies.length);
console.log('前 5 个:', proxies.slice(0, 5).map((p) => `${p.name}(${p.type})`).join(' | '));
console.log('有 dns.nameserver-policy:', !!doc?.dns?.['nameserver-policy'], ' 有 hosts:', !!doc?.hosts);
console.log('订阅自带 proxy-groups:', (doc?.['proxy-groups'] ?? []).length);

// 配置生成自检:不连网,直接看 buildConfig 出来的 mihomo 配置对不对
// 用法:node scripts/check-config.mjs
import { buildConfig } from '../src/main/config.ts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templatePath = resolve(here, '../../../packages/rules/ai-network-script.js');

const base = {
  templatePath,
  homeRegion: 'CN',
  tun: true,
  mixedPort: 17897,
  controllerPort: 19797,
  secret: 'test',
  aiRoutes: { chatgpt: 'static', gemini: 'static', grok: 'node', meta: 'node' },
  userRules: [{ domain: 'example.com', route: 'node' }],
  autoRegion: '',
};

const line = { type: 'socks5', server: '203.0.113.10', port: 1080, username: 'u', password: 'p', exitIp: '203.0.113.10', viaNode: false };
const subs = [{ id: 's1', name: 'test', url: 'https://example.com/sub', dns: { nameserverPolicy: {}, hosts: {} } }];

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) fail++; };

// ---------- 1. 有静态 IP + 有订阅(经节点) ----------
console.log('\n[1] 静态 IP + 订阅 + 经节点连接');
const c1 = buildConfig({ ...base, line: { ...line, viaNode: true }, ownSubs: subs });
const g1 = c1['proxy-groups'].map((g) => `${g.name}:${g.type}`);
console.log('  组:', g1.join(' | '));
ok(c1.proxies.some((p) => p.name === 'AI 专用出口 · 静态 IP' && p.server === '203.0.113.10'), '静态 IP 写进了 proxies');
const ai1 = c1['proxy-groups'].find((g) => g.name === 'AI 专用出口');
ok(!!ai1, '有「AI 专用出口」组');
ok(c1['proxy-groups'].some((g) => g.name === 'AI 放行' && g.proxies.includes('REJECT')), '有「AI 放行」闸门组(默认 REJECT)');
ok(c1['proxy-groups'].some((g) => g.name === '普通代理'), '有「普通代理」组');
ok(c1['proxy-providers']['user-sub-s1']?.url === 'https://example.com/sub', '订阅进了 proxy-providers');
ok(!Object.keys(c1['proxy-providers']).some((k) => k.includes('ain-ip')), '没有依赖平台的下发节点(ain-ip)');
const claudeRule = c1.rules.find((r) => r.includes('claude.ai'));
console.log('  claude 规则:', claudeRule);
ok(c1.rules.includes('DOMAIN-SUFFIX,claude.ai,AI 放行'), 'Claude 域名先到闸门');
ok(c1.rules.some((r) => r === 'DOMAIN-SUFFIX,example.com,普通代理'), '自定义规则生效(走节点)');
ok(c1.rules.some((r) => r === 'DOMAIN,www.cloudflare.com,AI 专用出口'), '出口核对域名直连 AI 组(不经闸门)');
const np = c1.dns['nameserver-policy'];
const aiDnsKeys = Object.keys(np).filter((k) => JSON.stringify(np[k]).includes('#AI 专用出口'));
ok(aiDnsKeys.length >= 2, `AI 域名的 DNS 走静态 IP(${aiDnsKeys.length} 条策略)`);
ok(c1.ipv6 === true, 'TUN 模式下开 IPv6(防泄漏)');
ok(c1.tun['dns-hijack'].includes('any:53'), 'TUN 接管 53 端口');
ok(c1['find-process-mode'] === 'strict', '开了进程名识别(Claude.exe 等)');

// ---------- 2. 有静态 IP + 订阅,但直连静态 IP ----------
console.log('\n[2] 静态 IP + 订阅,直连静态 IP(不经节点)');
const c2 = buildConfig({ ...base, line, ownSubs: subs });
ok(!!c2['proxy-groups'].find((g) => g.name === 'AI 专用出口'), '有「AI 专用出口」组');
ok(!c2['proxy-groups'].some((g) => g.name === 'AI 前置'), '不经节点时没有「AI 前置」组');
const local2 = c2.proxies.find((p) => p.name === 'AI 专用出口 · 静态 IP');
ok(local2 && !local2['dialer-proxy'], '静态 IP 节点没有 dialer-proxy(直连)');

// ---------- 3. 只有订阅(没有静态 IP) ----------
console.log('\n[3] 只有订阅(AI 走节点)');
const c3 = buildConfig({ ...base, line: { ...line, type: 'none' }, ownSubs: subs });
ok(!c3['proxy-groups'].some((g) => g.name === 'AI 专用出口'), '没有「AI 专用出口」组');
ok(!c3['proxy-groups'].some((g) => g.name === 'AI 放行'), '没有闸门(没静态 IP 时不拦)');
const claudeRule3 = c3.rules.find((r) => r.includes('claude.ai'));
console.log('  claude 规则:', claudeRule3);
ok(c3.rules.includes('DOMAIN-SUFFIX,claude.ai,普通代理'), 'Claude 域名走普通代理组');
ok(c3.rules.some((r) => r.startsWith('AND,((NETWORK,UDP),(DST-PORT,443)') && r.endsWith(',REJECT')), 'QUIC 拦截规则还在');
ok(!c3.proxies.some((x) => x.name === 'AI 专用出口 · 静态 IP'), '没静态 IP 时没有占位节点残留');
const np3 = c3.dns['nameserver-policy'];
ok(!JSON.stringify(np3).includes('#AI 专用出口'), 'DNS 策略里没有 AI 组残留');
ok(Object.keys(c3['proxy-providers']).length === 1 && !!c3['proxy-providers']['user-sub-s1'], '只有订阅节点集,没有 ain-ip / ain-guard');

// ---------- 4. 什么都没有 ----------
console.log('\n[4] 没线路(兜底不崩)');
const c4 = buildConfig({ ...base, line: { ...line, type: 'none' }, ownSubs: [] });
ok(c4['proxy-groups'].some((g) => g.name === '普通代理' && g.proxies.includes('DIRECT')), '普通代理组兜底 DIRECT,不会变 COMPATIBLE');

// ---------- 5. ChatGPT/Gemini 改走节点 ----------
console.log('\n[5] ChatGPT / Gemini 改走节点');
const c5 = buildConfig({ ...base, line, ownSubs: subs, aiRoutes: { chatgpt: 'node', gemini: 'node', grok: 'static', meta: 'static' } });
ok(c5.rules.some((r) => r === 'DOMAIN-SUFFIX,chatgpt.com,普通代理'), 'ChatGPT 规则改到普通代理');
ok(c5.rules.some((r) => r === 'DOMAIN-SUFFIX,grok.com,AI 专用出口'), 'Grok 选了静态 IP 就加规则');
ok(Object.keys(c5.dns['nameserver-policy']).some((k) => k.startsWith('+.chatgpt.com')), 'ChatGPT 的 DNS 也跟着走节点');

// 打印一份规则里涉及 AI 的部分,方便肉眼过一遍
console.log('\n[附] c1 里和 AI 相关的规则(前 14 条):');
for (const r of c1.rules.filter((r) => r.includes('AI 放行') || r.includes('AI 专用出口')).slice(0, 14)) console.log('   ', r);

console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);

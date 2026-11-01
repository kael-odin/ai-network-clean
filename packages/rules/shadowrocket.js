// 按设备生成 Shadowrocket(小火箭)的 .conf 配置:AI 域名走独享 · 静态 ISP 代理 IP,本地网站直连,其余走用户自己选的节点。
// 规则来自本目录的规则集 yaml(和 Clash 脚本、规则服务用同一份),所以两边的域名永远一致。
//
// 和 Clash 的区别:
//   - Clash 脚本里没有账号密码,节点由规则服务凭令牌下发;小火箭只能导入一个配置链接,所以节点(含账号密码)直接写在
//     这份配置里。配置链接 = 令牌,和脚本一样要保密,泄露时在插件里重置这台设备。
//   - 凭据重置后,手机里的配置要更新(小火箭会按订阅更新频率自动拉)才会换上新凭据。
//
// 小火箭没有公开的官方语法文档。代理链(小火箭叫"代理通过")在配置文件里的写法,来自用户手里一份能用的第三方 Conf:
//   节点行末尾写 `chain=<代理分组名>`,那个分组是用户自己订阅节点组成的(自动选择 / 手动选择),独享 · 静态 ISP 代理 IP 经它转发。
// 手册只写了界面里的"代理通过",没有写配置里的参数名;`underlying-proxy`(Surge 的写法)小火箭不认,真机测速超时就是它没生效。
// 其余部分按手册里的 `节点名=socks5,地址,端口,用户,密码` 和策略组写法来写。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SHADOWROCKET_VERSION = '1.1.0';

// 与 ai-network-script.js 的 SERVICES 一致:三个服务 + 登录 + 验证 + 付款 + IP 检测网站,全开
const RULE_SETS = ['claude-core', 'chatgpt-core', 'gemini-core', 'login-google', 'login-apple', 'login-microsoft', 'verify-cloudflare', 'pay-stripe', 'pay-google', 'ip-check'];
// 节点名默认取线路节点的名字(「AI Network · US」),小火箭首页和分组里显示的就是它;早期数据叫「AI 专用 · …」,统一成品牌名
const NODE_NAME = 'AI Network';
// 名字里不能有逗号、等号和控制字符(小火箭按逗号切、按等号分名字)
const NAME_BAD = new RegExp('[,=' + Array.from({ length: 33 }, (_, i) => String.fromCharCode(i < 32 ? i : 127)).join('') + ']', 'g');
const nodeNameOf = (node) => {
  const raw = String(node.name ?? '').replace(/^AI 专用 · /, 'AI Network · ').replace(NAME_BAD, ' ').replace(/ +/g, ' ').trim();
  return raw || NODE_NAME;
};
const GROUP = 'AI Network';
// 前置分组:独享 · 静态 ISP 代理 IP 在国内直连不通,要经用户自己的节点转发。成员用 policy-regex-filter 取用户在小火箭里的全部节点,排除我们自己的节点
const FRONT = '前置中转';
const FRONT_AUTO = '自动选择';
const FRONT_MANUAL = '手动选择';
// 按顺序切换(PM 10-28):当前节点连不上就换下一个能用的(小火箭的 fallback 分组),和「自动选择」(选最快)二选一
const FRONT_FALLBACK = '按顺序切换';
// 成员的筛选:排除我们自己的节点和分组;也排除机场订阅里的说明条目(「套餐:xx」「剩余流量:xx」「到期时间:xx」「官网:xx」),
// 它们不是真节点,常被测速选中后全断(电脑客户端 10-20 就排除了,规则和 apps/desktop 的 INFO_NODE_FILTER 一致)
const NOT_OURS = '^(?!\\s*(官网|网址)\\s*[:：])(?![^:：]{0,10}(套餐|剩余|到期|过期|重置|流量)[^:：]{0,8}[:：])((?!(AI Network|AI-Network|前置中转|自动选择|手动选择|按顺序切换|日常上网)).)*$';
// 测速:每 1 分钟测一次(原来 5 分钟,节点断了最长要等 5 分钟才换,PM 10-28),超时 3 秒
// 其余海外流量走的分组:不依赖小火箭首页当前选中的节点(PROXY)。首页如果选中了独享 · 静态 ISP 代理 IP 节点,FINAL,PROXY 会让全部流量都去走独享 · 静态 ISP 代理 IP
const DAILY = '日常上网';
const TEST_URL = 'http://www.gstatic.com/generate_204';
const TEST = `url=${TEST_URL},interval=60,tolerance=50,timeout=3`;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function fail(msg) {
  throw new Error('生成小火箭配置:' + msg);
}

// 规则集 yaml 的 payload:每行 `  - DOMAIN-SUFFIX,x.com   # 注释`;只取规则本身
function readPayload(rulesDir, name) {
  const text = fs.readFileSync(path.join(rulesDir, name + '.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const out = [];
  let inPayload = false;
  for (const raw of text.split('\n')) {
    if (/^payload:\s*$/.test(raw)) { inPayload = true; continue; }
    if (!inPayload) continue;
    const m = /^\s*-\s*([A-Z-]+),([^\s#]+)\s*(?:#.*)?$/.exec(raw);
    if (!m) continue;
    if (!['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR'].includes(m[1])) fail('规则集 ' + name + ' 里有小火箭不认的规则类型:' + m[1]);
    out.push(m[1] + ',' + m[2]);
  }
  if (out.length === 0) fail('规则集 ' + name + ' 是空的');
  return out;
}

// 节点各字段会写进用逗号分隔的一行,不能有逗号、空白、等号以外的特殊字符;不合规就拒绝,不要生成一份会被解析错的配置
function checkNode(node) {
  if (!node || typeof node !== 'object') fail('没有节点');
  if (node.type !== 'socks5' && node.type !== 'http') fail('节点协议只支持 socks5 或 http');
  if (!HOST_RE.test(String(node.server))) fail('节点地址不合法');
  const port = Number(node.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('节点端口不合法');
  for (const k of ['username', 'password']) {
    const v = String(node[k] ?? '');
    if (!v || v.length > 128 || /[,\s\u0000-\u001f\u007f#]/.test(v)) fail('节点的' + (k === 'username' ? '用户名' : '密码') + '含有不能写进配置的字符');
  }
  return { type: node.type, server: String(node.server), port, username: String(node.username), password: String(node.password) };
}

/**
 * @param {object} o
 * @param {string} o.rulesDir    规则集 yaml 所在目录(packages/rules)
 * @param {string} o.updateUrl   这份配置自己的下载地址(含设备令牌),写进 update-url 供小火箭自动更新
 * @param {string} o.checkDomain 自检域名(探针),必须走 AI Network 专用组,插件的出口检测才准
 * @param {string} o.homeRegion  本地直连的国家代码,例如 CN
 * @param {{type:string,server:string,port:number,username:string,password:string}} o.node
 * @param {string} [o.checkPageUrl] 这台设备的手机自检页地址:写成 URL 重写,手机浏览器输入自检域名就跳到自检页,不用回电脑扫码
 * @param {'auto'|'direct'} [o.front='auto']  'auto' = 独享 · 静态 ISP 代理 IP 经用户当前选中的节点(PROXY)连接
 * @param {string} [o.deviceName]
 * @param {Date} [o.now]
 */
function generateShadowrocketConf(o = {}) {
  const node = checkNode(o.node);
  const nodeName = nodeNameOf(o.node ?? {});
  const homeRegion = String(o.homeRegion || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(homeRegion)) fail('本地地区要用两位国家代码');
  const checkDomain = String(o.checkDomain || '').toLowerCase();
  if (!HOST_RE.test(checkDomain)) fail('自检域名无效');
  let updateUrl;
  try { updateUrl = new URL(String(o.updateUrl)); } catch { fail('更新地址无效'); }
  if (updateUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(updateUrl.hostname)) fail('更新地址必须是 https');
  const front = o.front ?? 'auto';
  if (front !== 'auto' && front !== 'direct') fail('前置只能是 auto 或 direct');
  let checkPageUrl = null;
  if (o.checkPageUrl != null) {
    try { checkPageUrl = new URL(String(o.checkPageUrl)); } catch { fail('自检页地址无效'); }
    if (checkPageUrl.protocol !== 'https:' || /[\s,]/.test(checkPageUrl.href)) fail('自检页地址必须是 https 且不含空格');
  }
  const name = String(o.deviceName ?? '').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '未命名设备';
  const now = o.now instanceof Date ? o.now : new Date();

  const aiRules = [];
  const seen = new Set();
  for (const set of RULE_SETS) {
    for (const r of readPayload(o.rulesDir, set)) {
      if (seen.has(r)) continue;
      seen.add(r);
      aiRules.push(r + ',' + GROUP);
    }
  }

  const chain = front === 'auto' ? `,chain=${FRONT}` : '';
  const lines = [
    `# AI Network · 小火箭(Shadowrocket)配置 v${SHADOWROCKET_VERSION}`,
    '# Claude、ChatGPT、Gemini(含 Google AI Studio)共用同一个独享 · 静态 ISP 代理 IP',
    `# 设备:${name} · 生成时间:${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '#',
    '# 这份配置含独享 · 静态 ISP 代理 IP 的账号密码,配置链接不要发给别人;泄露时在插件里重置这台设备。',
    '# AI 域名走独享 · 静态 ISP 代理 IP;本地地区(创建设备时选的)直连;其余走「日常上网」分组(默认自动选你订阅里最快的节点)。',
    ...(checkPageUrl ? [`# 想在手机上检查分流:浏览器地址栏输入 ${checkDomain},会打开这台设备的自检页。`] : []),
    '',
    '[General]',
    'bypass-system = true',
    'skip-proxy = 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local, captive.apple.com',
    'tun-excluded-routes = 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 255.255.255.255/32, 239.255.255.250/32',
    'dns-server = https://cloudflare-dns.com/dns-query, https://8.8.4.4/dns-query',
    'fallback-dns-server = 8.8.8.8, 1.1.1.1',
    'dns-direct-system = false',
    'ipv6 = false',
    'prefer-ipv6 = false',
    'private-ip-answer = true',
    'dns-direct-fallback-proxy = false',
    'icmp-auto-reply = true',
    'always-reject-url-rewrite = false',
    'udp-policy-not-supported-behaviour = REJECT',
    'use-local-host-item-for-proxy = false',
    `update-url = ${updateUrl.toString()}`,
    '',
    '[Proxy]',
    // 节点行和分组行的逗号后面不能有空格:小火箭按逗号直接切,有空格地址、chain 参数名、成员名前面都会带着空格,识别不了
    `${nodeName} = ${node.type},${node.server},${node.port},${node.username},${node.password},udp=1${chain}`,
    '',
    '[Proxy Group]',
    `${GROUP} = select,${nodeName}`,
    '# 日常上网:除 AI 和本地直连以外的流量。默认自动选最快的节点,也可以手动换或直连',
    `${DAILY} = select,${FRONT_AUTO},${FRONT_FALLBACK},${FRONT_MANUAL},DIRECT`,
    ...(front === 'auto' ? [
      '# 前置中转:独享 · 静态 ISP 代理 IP 经这里转发(国内直连不了独享 · 静态 ISP 代理 IP)。默认自动选最快的,也可以按顺序切换或手动换',
      `${FRONT} = select,${FRONT_AUTO},${FRONT_FALLBACK},${FRONT_MANUAL}`,
    ] : []),
    '# 自动选择 / 按顺序切换 / 手动选择:成员是你在小火箭里的全部节点(按名字筛选,排除我们自己的节点和机场的说明条目)',
    `${FRONT_AUTO} = url-test,${TEST},policy-regex-filter=${NOT_OURS}`,
    `${FRONT_FALLBACK} = fallback,${TEST},policy-regex-filter=${NOT_OURS}`,
    `${FRONT_MANUAL} = select,${TEST},policy-regex-filter=${NOT_OURS}`,
    '',
    '[Rule]',
    '# 局域网',
    'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
    'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
    '# 自检域名:插件的出口检测靠它看到 AI 流量的出口',
    `DOMAIN,${checkDomain},${GROUP}`,
    '# AI 服务、登录、人机验证、付款(与 Clash 脚本同一份规则集)',
    ...aiRules,
    '# 本地地区直连',
    `GEOIP,${homeRegion},DIRECT`,
    `FINAL,${DAILY}`,
    '',
    // 手机浏览器地址栏输入自检域名(http),小火箭在本地直接 302 到这台设备的自检页;https 的重写需要 MITM,不做
    ...(checkPageUrl ? [
      '[URL Rewrite]',
      `# 手机上随时自检:浏览器输入 ${checkDomain} 就打开这台设备的自检页`,
            `^http://${checkDomain.replace(/\./g, '\\.')}/?$ ${checkPageUrl.href} 302`,
      '',
    ] : []),
  ];
  // 发给用户的配置去掉各段里的注释(仓库里这份生成代码保留说明),只留开头的品牌和声明
  let inSection = false;
  return lines.filter((l) => {
    if (l.startsWith('[')) inSection = true;
    return !(inSection && l.startsWith('#'));
  }).join('\n');
}

module.exports = { generateShadowrocketConf, SHADOWROCKET_VERSION, RULE_SETS, NODE_NAME, GROUP };

// AI Network · AI 分流脚本(Clash Verge Rev 扩展脚本)
// 支持 Claude、ChatGPT、Gemini / Google AI Studio;已开启的服务共用同一个静态出口。
//
// 用法:Clash Verge Rev → 订阅 → 右键当前订阅 → 扩展脚本 → 粘贴全部内容 → 保存
// 规则和域名表都内置在本脚本里,不依赖远端规则服务;静态 IP 在下面的 AIN.proxy 里填。

const AIN = {
  // ---- 出口与规则 ----
  ruleBase: null,                    // 远端规则服务前缀;本项目不用,保持 null
  checkDomain: null,                 // 自检域名;本项目不用,保持 null
  // 直接写入静态 IP 节点(含密码),不依赖远端下发
  proxy: null,

  // ---- 分流设置(用户在插件里选择) ----
  mode: 'split',          // 'split' = 三层分流;'ai-only' = 只接管已开启的 AI 服务,其余保持订阅原有规则
  homeRegion: 'US',       // 本地直连的国家代码,首次配置时由插件自动识别
  front: 'auto',          // 连接静态 IP 的前置代理:'auto' = 普通代理组;null = 直连静态 IP
  services: {             // 哪些 AI 服务走静态 IP
    claude: true,
    chatgpt: true,
    gemini: true,         // 含 Google AI Studio
  },
  links: {                // 已开启服务的附属链路是否也走静态 IP(这些域名也被其他网站使用)
    auth: true,           // 第三方登录(Google / Apple / Microsoft,按服务需要)
    verify: true,         // 人机验证(Cloudflare)
    pay: true,            // 付款(Stripe / Google)
  },
};

const G_AI = 'AI 专用出口';
const G_PROXY = '普通代理';
const G_FRONT = 'AI 前置';  // 静态 IP 经它连接:用户选的前置不可用时自动换到订阅里其他可用的节点
const TAG = 'ain-';       // 本脚本加入的规则集、节点集统一前缀,用于清理
// 脚本版本:改了 SERVICES、FALLBACK 等需要重新粘贴的逻辑时加一
const SCRIPT_VERSION = '1.4.5';
const TEST_URL = 'https://www.gstatic.com/generate_204';
// 静态 IP 经前置时,一次健康检查要走 前置握手 + SOCKS5 认证 + TLS,跨洋时 2 秒左右很常见;
// 默认 5 秒超时遇到晚高峰波动会误判不可用,AI 网站被阻断一分钟。放宽到 10 秒(真断了照样判不可用)
const CHAIN_TIMEOUT = 10000;
// 基于 UDP 的协议:运营商限速 UDP 时这类节点会一起断,备用前置优先用基于 TCP 的节点
const UDP_TYPES = ['hysteria', 'hysteria2', 'tuic', 'wireguard'];
const NOT_NODE_TYPES = ['direct', 'reject', 'reject-drop', 'pass', 'dns', 'compatible'];

// 阻断节点:连向本机不存在的端口,连接必然失败。节点拉取失败、本地也没有缓存时 AI Network 专用组只剩它,
// 请求直接失败。不能让组变空:Mihomo 会给空组填上 COMPATIBLE,而 COMPATIBLE 就是直连,会暴露真实 IP
const GUARD = { name: 'AI · 未就绪(阻断)', type: 'socks5', server: '127.0.0.1', port: 9 };
const LOCAL_NAME = 'AI 专用出口 · 静态 IP'; // 本地测试时写入的节点名
const QUIC_PREFIX = 'AND,((NETWORK,UDP),(DST-PORT,443),'; // 后面跟 AI 流量条件;用户自己的 '…443)),REJECT' 不会被误认

// 每个 AI 服务用到的规则集。附属链路按服务商拆分,只开 Claude 时不会把 Microsoft 登录也送到静态 IP
// process:桌面客户端 / CLI 的进程名,只在 TUN 模式下生效,让不走系统代理的程序也进 AI Network 专用组
//   macOS 上 Claude 的网络请求由 'Claude Helper' 发出;npm 安装的 Claude Code 进程是 node,只能靠域名规则
//   (进程名需按各平台、各版本实测)
const SERVICES = {
  claude: {
    core: 'claude-core', auth: ['login-google', 'login-apple'], verify: ['verify-cloudflare'], pay: ['pay-stripe'],
    process: ['Claude.exe', 'Claude', 'Claude Helper', 'claude.exe', 'claude'],
  },
  chatgpt: {
    core: 'chatgpt-core', auth: ['login-google', 'login-apple', 'login-microsoft'], verify: ['verify-cloudflare'],
    pay: ['pay-stripe'], process: ['ChatGPT.exe', 'ChatGPT'],
  },
  gemini: {
    core: 'gemini-core', auth: ['login-google'], verify: [], pay: ['pay-google'], process: [],
  },
};

// 在线规则集下载失败时的兜底,必须与对应的 .yaml 保持一致(待抓包确认的候选不放进来)
// 同时用于生成 DNS 分流,保证 AI 相关域名的 DNS 出口与 HTTP 出口一致
const FALLBACK = {
  'claude-core': [
    'DOMAIN-SUFFIX,claude.ai',
    'DOMAIN-SUFFIX,claude.com',
    'DOMAIN-SUFFIX,anthropic.com',
    'DOMAIN-SUFFIX,claudeusercontent.com',
    'DOMAIN-SUFFIX,clau.de',
    'DOMAIN-SUFFIX,hcaptcha.com',
    'DOMAIN,browser-intake-us5-datadoghq.com',
    'DOMAIN-SUFFIX,intercom.io',
    'DOMAIN-SUFFIX,intercomcdn.com',
    'DOMAIN-SUFFIX,intercomassets.com',
  ],
  'chatgpt-core': [
    'DOMAIN-SUFFIX,chatgpt.com',
    'DOMAIN-SUFFIX,openai.com',
    'DOMAIN-SUFFIX,oaistatic.com',
    'DOMAIN-SUFFIX,oaiusercontent.com',
    'DOMAIN-SUFFIX,chat.com',
  ],
  'gemini-core': [
    'DOMAIN,gemini.google.com',
    'DOMAIN-SUFFIX,gemini.google',
    'DOMAIN,bard.google.com',
    'DOMAIN,aistudio.google.com',
    'DOMAIN,makersuite.google.com',
    'DOMAIN,alkalimakersuite-pa.clients6.google.com',
    'DOMAIN,generativelanguage.googleapis.com',
  ],
  'login-google': ['DOMAIN,accounts.google.com', 'DOMAIN,oauth2.googleapis.com'],
  'login-apple': ['DOMAIN,appleid.apple.com'],
  'login-microsoft': ['DOMAIN,login.microsoftonline.com', 'DOMAIN,login.live.com', 'DOMAIN,signup.live.com', 'DOMAIN,account.live.com', 'DOMAIN,account.microsoft.com'],
  'verify-cloudflare': ['DOMAIN,challenges.cloudflare.com'],
  'pay-stripe': ['DOMAIN-SUFFIX,stripe.com', 'DOMAIN-SUFFIX,stripe.network', 'DOMAIN-SUFFIX,stripecdn.com'],
  'pay-google': ['DOMAIN,one.google.com', 'DOMAIN,payments.google.com', 'DOMAIN,pay.google.com'],
  // IP 检测网站:不是 AI 服务,但用户在这些网站查到的要是静态 IP,不然看到机场 IP 评分差会以为静态 IP 不纯净。
  // 体检用的 api.ipify.org、cloudflare.com、myip.ipip.net 不能放进来(它们代表「其他网站」的出口)
  'ip-check': [
    'DOMAIN-SUFFIX,ping0.cc', 'DOMAIN-SUFFIX,ipinfo.io', 'DOMAIN-SUFFIX,whoer.net', 'DOMAIN-SUFFIX,browserleaks.com',
    'DOMAIN-SUFFIX,ipqualityscore.com', 'DOMAIN-SUFFIX,scamalytics.com', 'DOMAIN-SUFFIX,ip.sb', 'DOMAIN-SUFFIX,iplocation.net',
    'DOMAIN-SUFFIX,ipleak.net', 'DOMAIN-SUFFIX,ip2location.com', 'DOMAIN-SUFFIX,db-ip.com', 'DOMAIN-SUFFIX,maxmind.com',
    'DOMAIN-SUFFIX,iphey.com', 'DOMAIN-SUFFIX,pixelscan.net', 'DOMAIN-SUFFIX,ip-api.com', 'DOMAIN-SUFFIX,ipapi.co',
    'DOMAIN-SUFFIX,proxycheck.io', 'DOMAIN-SUFFIX,abuseipdb.com', 'DOMAIN-SUFFIX,ip125.com', 'DOMAIN-SUFFIX,ipaddress.my',
    'DOMAIN-SUFFIX,ippure.com', 'DOMAIN-SUFFIX,iplark.com', 'DOMAIN-SUFFIX,ipapi.is', 'DOMAIN-SUFFIX,ipdata.co', 'DOMAIN-SUFFIX,browserscan.net',
    'DOMAIN-SUFFIX,ipcheck.ing', 'DOMAIN-SUFFIX,whatismyipaddress.com', 'DOMAIN-SUFFIX,whatismyip.com', 'DOMAIN-SUFFIX,myip.com', 'DOMAIN-SUFFIX,iplocation.io',
    'DOMAIN-SUFFIX,ipwho.is', 'DOMAIN-SUFFIX,ipregistry.co', 'DOMAIN-SUFFIX,ip.gs', 'DOMAIN-SUFFIX,ifconfig.me', 'DOMAIN-SUFFIX,ifconfig.co', 'DOMAIN-SUFFIX,net.coffee',
  ],
};
// 不属于某个服务、只要开了任一 AI 服务就一起走静态 IP 的规则集
const EXTRA_SETS = ['ip-check'];

// 各国本地 DNS(DoH,直连)。未列出的国家使用 DEFAULT
const HOME_DNS = {
  CN: ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'],
  DEFAULT: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
};
// 只有中国有较完整的国家域名库;其他国家按 IP 判断本地
const HOME_GEOSITE = { CN: 'cn' };

// 不能拿假 IP 的域名:局域网、时间同步、系统联网检测、主机游戏联机。与订阅原有列表合并
const FAKE_IP_FILTER = [
  '+.lan', '+.local', '+.localdomain', '+.localhost', '+.invalid',
  '+.pool.ntp.org', 'time.*.com', 'ntp.*.com', 'time.*.apple.com',
  '+.msftconnecttest.com', '+.msftncsi.com',
  'xbox.*.microsoft.com', 'xnotify.xboxlive.com', '+.srv.nintendo.net',
];

const LAN_RULES = ['GEOIP,private,DIRECT,no-resolve', 'DOMAIN-SUFFIX,local,DIRECT', 'DOMAIN-SUFFIX,lan,DIRECT'];

function main(config, profileName) {
  // 去掉上次加入的规则;局域网规则会重新加在最前面,订阅里相同的条目一并去重
  const userRules = (config.rules || []).filter((r) => !isOurs(r) && !LAN_RULES.includes(r));
  const local = AIN.proxy ? checkLocalProxy(AIN.proxy) : null;
  const userProxies = (config.proxies || []).filter((p) => p.name !== LOCAL_NAME);
  const userGroups = (config['proxy-groups'] || []).filter((g) => ![G_AI, G_PROXY, G_FRONT].includes(g.name));

  // 1. 普通代理组(三层分流时):收纳订阅里的全部节点
  const groups = [];
  if (AIN.mode === 'split') {
    const names = userProxies.map((p) => p.name).concat(userGroups.map((g) => g.name));
    groups.push({ name: G_PROXY, type: 'select', proxies: names.length ? names : ['DIRECT'] });
  }

  // 2. 前置组:用户选的前置(普通代理组或订阅的兜底组)排第一,订阅里的全部节点作备用。
  //    前置组是 select 时会一直钉在选中的那个节点上,它断了(比如运营商限速 UDP,hy2 节点全断)
  //    静态 IP 就跟着不可用,而用户换别的节点上网一切正常。fallback 只在选中的不可用时才换,恢复后自动换回
  const front = pickFront(userRules, userGroups);
  const proxyProviders = {};
  for (const k of Object.keys(config['proxy-providers'] || {})) {
    if (!k.startsWith(TAG)) proxyProviders[k] = config['proxy-providers'][k];
  }
  if (front) groups.push(frontGroup(front, userProxies, Object.keys(proxyProviders)));
  const via = front ? G_FRONT : null;

  // 3. 静态 IP 节点:直接写进配置,需要时经前置组
  config.proxies = userProxies;
  if (local) {
    // 节点直接写进配置
    config.proxies.push(Object.assign(local, { name: LOCAL_NAME }, via ? { 'dialer-proxy': via } : {}));
  } else {
    proxyProviders[TAG + 'ip'] = Object.assign({
      type: 'http', url: AIN.ruleBase + '/ip.yaml?v=' + SCRIPT_VERSION, path: './proxies/' + TAG + 'ip.yaml',
      interval: 3600, proxy: via || 'DIRECT',
      'health-check': { enable: true, url: TEST_URL, interval: 300, lazy: true, timeout: CHAIN_TIMEOUT },
    }, via ? { override: { 'dialer-proxy': via } } : {});
    proxyProviders[TAG + 'guard'] = { type: 'inline', payload: [GUARD] };
  }
  config['proxy-providers'] = proxyProviders;

  // 4. AI Network 专用组:只有静态 IP,失效即失败,不回退到其他节点。
  //    fallback 按顺序取第一个健康的成员:静态 IP 可用时就是它,不可用时只剩阻断节点。
  //    不能用 select:store-selected 会把「阻断」记住成用户的选择,节点恢复后也不会自动切回
  groups.unshift(AIN.proxy
    ? { name: G_AI, type: 'select', proxies: [LOCAL_NAME] }
    : {
      name: G_AI, type: 'fallback', use: [TAG + 'ip', TAG + 'guard'],
      url: TEST_URL, interval: 60, timeout: CHAIN_TIMEOUT,
    });
  config['proxy-groups'] = groups.concat(userGroups);

  // 5. 在线规则集
  const providers = {};
  for (const k of Object.keys(config['rule-providers'] || {})) {
    if (!k.startsWith(TAG)) providers[k] = config['rule-providers'][k];
  }
  const on = Object.keys(SERVICES).filter((k) => AIN.services[k]).map((k) => SERVICES[k]);
  const sets = unique([].concat(...on.map((sv) => [sv.core].concat(
    AIN.links.auth ? sv.auth : [],
    AIN.links.verify ? sv.verify : [],
    AIN.links.pay ? sv.pay : [])), on.length ? EXTRA_SETS : []));
  for (const s of AIN.ruleBase ? sets : []) {
    providers[TAG + s] = {
      type: 'http', behavior: 'classical', format: 'yaml',
      url: AIN.ruleBase + '/' + s + '.yaml?v=' + SCRIPT_VERSION, path: './ruleset/' + TAG + s + '.yaml',
      interval: 21600, proxy: via || 'DIRECT',
    };
  }
  config['rule-providers'] = providers;

  // 6. 规则:局域网 → 拦截 AI 服务的 QUIC → AI 服务 → 本地直连 → 普通代理
  const fallback = sets.reduce((a, s) => a.concat(FALLBACK[s]), AIN.checkDomain ? ['DOMAIN,' + AIN.checkDomain] : []);
  const aiMatch = [].concat(...on.map((sv) => sv.process)).map((n) => 'PROCESS-NAME,' + n)
    .concat(AIN.ruleBase ? sets.map((s) => 'RULE-SET,' + TAG + s) : [])
    .concat(fallback);
  // 静态 IP 经前置代理时,UDP 转发经常不通:直接拒绝 QUIC,浏览器立即改走 TCP,避免首次打开卡顿。
  // 只作用于 AI 相关流量,其余 QUIC 不受影响
  const anyAi = aiMatch.length > 1 ? '(OR,(' + aiMatch.map((m) => '(' + m + ')').join(',') + '))' : '(' + aiMatch[0] + ')';
  const noQuic = aiMatch.length ? [QUIC_PREFIX + anyAi + '),REJECT'] : [];
  const aiRules = aiMatch.map((m) => m + ',' + G_AI);
  const lan = LAN_RULES;
  if (AIN.mode === 'split') {
    const home = [];
    if (HOME_GEOSITE[AIN.homeRegion]) home.push('GEOSITE,' + HOME_GEOSITE[AIN.homeRegion] + ',DIRECT');
    // 不加 no-resolve:域名会经普通代理的远端 DNS 解析后再按国家 IP 判断,
    // 本地网站才能直连;AI 域名在前面已匹配,不会走到这里被解析
    home.push('GEOIP,' + AIN.homeRegion + ',DIRECT');
    config.rules = lan.concat(noQuic, aiRules, home, ['MATCH,' + G_PROXY]);
  } else {
    config.rules = lan.concat(noQuic, aiRules, userRules.length ? userRules : ['MATCH,DIRECT']);
  }

  // 7. DNS 防泄漏:AI 相关域名经静态 IP 解析;本地域名用本地 DNS;其余经普通代理
  //    保留订阅原有的 DNS 分流(去掉我们上次加的、以及引用了已不存在规则集的条目)
  const homeDns = HOME_DNS[AIN.homeRegion] || HOME_DNS.DEFAULT;
  const remote = AIN.mode === 'split' ? G_PROXY : (front || 'DIRECT');
  const baseDns = config.dns || {};
  const policy = {};
  for (const [k, v] of Object.entries(baseDns['nameserver-policy'] || {})) {
    if ([].concat(v).some((s) => String(s).endsWith('#' + G_AI))) continue;
    if (k === 'geosite:' + HOME_GEOSITE[AIN.homeRegion]) continue;   // 下面会重新加入
    if (k.startsWith('rule-set:') && !k.slice(9).split(',').every((n) => providers[n.trim()])) continue;
    policy[k] = v;
  }
  // 新增节点解析 DNS 后,nameserver-policy 不再用于节点域名。
  // 没有独立节点 DNS 的订阅需把原策略迁移过去,否则供应商专用解析会失效。
  // 在加入 AI DNS 前取策略,避免节点解析依赖 AI 出口,形成循环。
  const proxyDnsPolicy = Object.assign({},
    baseDns['proxy-server-nameserver'] ? {} : policy,
    baseDns['proxy-server-nameserver-policy'] || {});
  // 分成几条:一条的名字太长(超过 1024 个字符)内核读配置会报错退出(10-30 检测网站名单加长后 0.1.22 测试包连不上)
  for (const key of dnsKeys(fallback)) policy[key] = ['https://1.1.1.1/dns-query#' + G_AI];
  if (HOME_GEOSITE[AIN.homeRegion]) policy['geosite:' + HOME_GEOSITE[AIN.homeRegion]] = homeDns;
  config.dns = Object.assign({}, baseDns, {
    enable: true,
    ipv6: false,
    'enhanced-mode': 'fake-ip',
    'respect-rules': true,
    'default-nameserver': ['223.5.5.5', '1.1.1.1'],
    nameserver: ['https://1.1.1.1/dns-query#' + remote],
    'nameserver-policy': policy,
    'proxy-server-nameserver': baseDns['proxy-server-nameserver'] || homeDns,
    'proxy-server-nameserver-policy': proxyDnsPolicy,
    'fake-ip-filter': unique((baseDns['fake-ip-filter'] || []).concat(FAKE_IP_FILTER)),
  });
  config.ipv6 = false;
  config['find-process-mode'] = 'strict';   // 识别进程名,供桌面客户端的 PROCESS-NAME 规则使用
  // 重启后保留前置节点的选择和假 IP 映射:浏览器缓存的假 IP 不会在重启后失效
  config.profile = Object.assign({}, config.profile, { 'store-selected': true, 'store-fake-ip': true });
  config.sniffer = Object.assign({ enable: true, 'parse-pure-ip': true,
    sniff: { HTTP: { ports: [80, 8080] }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443] } } }, config.sniffer);
  return config;
}

function isOurs(rule) {
  // QUIC 拦截规则按前缀识别:没有开启任何服务、或本地测试没有 ain- 规则集时也能清掉
  return rule.endsWith(',' + G_AI) || rule.endsWith(',' + G_PROXY) || rule.includes(',' + TAG) ||
    rule.startsWith(QUIC_PREFIX);
}

// 本地测试版的出口信息:去掉手填时带进来的首尾空格,端口转成数字(写成 '22265'、' 22265' 都可以)。
// 没填或填错时直接报错,Clash Verge 会显示这段提示,而不是生成一份内核无法解析或连不上的配置
function checkLocalProxy(p) {
  const node = {};
  for (const [k, v] of Object.entries(p)) node[k] = typeof v === 'string' ? v.trim() : v;
  const missing = ['server', 'port'].filter((k) => !node[k] || /填写/.test(String(node[k])));
  if (missing.length) throw new Error('请先填写静态 IP 的出口信息(' + missing.join('、') + ')');
  node.port = Number(node.port);
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    throw new Error('AI Network:端口要填 1–65535 之间的数字,现在是 ' + JSON.stringify(p.port));
  }
  node.type = String(node.type).toLowerCase();
  if (node.type !== 'socks5' && node.type !== 'http') throw new Error('AI Network:type 只能是 socks5 或 http');
  return node;
}

// DOMAIN-SUFFIX,a.com → +.a.com;DOMAIN,a.com → a.com
function toDnsKey(rule) {
  const [type, host] = rule.split(',');
  return type === 'DOMAIN-SUFFIX' ? '+.' + host : host;
}

// 规则 → nameserver-policy 的名字,每条不超过 800 个字符
function dnsKeys(rules) {
  const keys = [];
  let cur = '';
  for (const k of rules.map(toDnsKey)) {
    if (cur && cur.length + 1 + k.length > 800) { keys.push(cur); cur = ''; }
    cur = cur ? cur + ',' + k : k;
  }
  if (cur) keys.push(cur);
  return keys;
}

function unique(list) {
  return list.filter((v, i) => list.indexOf(v) === i);
}

// 前置组成员:用户选的前置排第一;其余是订阅里的节点(基于 TCP 的在前)和订阅自带的节点集。
// 订阅里的「剩余流量」「官网」之类的说明节点连不通,健康检查不会选中它们
function frontGroup(front, proxies, providers) {
  const nodes = proxies.filter((p) => p.name !== front && !NOT_NODE_TYPES.includes(String(p.type).toLowerCase()));
  const udp = (p) => UDP_TYPES.includes(String(p.type).toLowerCase());
  const backup = nodes.filter((p) => !udp(p)).concat(nodes.filter(udp)).map((p) => p.name);
  return Object.assign({ name: G_FRONT, type: 'fallback', proxies: [front].concat(backup) },
    providers.length ? { use: providers } : {},
    { url: TEST_URL, interval: 120, lazy: true });
}

// 前置代理:订阅兜底规则(MATCH)所用的组;三层分流时用普通代理组
function pickFront(rules, groups) {
  if (AIN.front === null) return null;
  if (AIN.front !== 'auto') return AIN.front;
  if (AIN.mode === 'split') return G_PROXY;
  const m = rules.find((r) => r.startsWith('MATCH,'));
  const t = m ? m.split(',')[1] : null;
  if (t && t !== 'DIRECT' && t !== 'REJECT' && groups.some((g) => g.name === t)) return t;
  const first = groups.find((g) => g.type === 'select');
  return first ? first.name : null;
}

if (typeof module !== 'undefined') module.exports = { main, AIN };

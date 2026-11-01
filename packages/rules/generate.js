// 按设备生成扩展脚本:把规则服务地址(含设备令牌)、自检域名和分流设置写进 ai-network-script.js 的 AIN 区块,
// 模板其余部分原样保留。由业务后台在用户点「复制脚本」时调用,也供规则服务的管理命令使用。
//
// 三个 AI 服务固定全开(2026-10-04 产品决定),不接受服务开关;可选的是分流模式、本地地区、附属链路和前置。
// 令牌、设备名等都来自外部输入:字符串一律用 JSON.stringify 写成字面量,设备名只进注释并去掉换行,
// 生成后再编译一次,保证输出的始终是一份语法正确、AIN 与输入一致的脚本。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripComments } = require('./strip-comments.js');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'ai-network-script.js'), 'utf8').replace(/\r\n/g, '\n');
const SCRIPT_VERSION = TEMPLATE.match(/^const SCRIPT_VERSION = '(\d+\.\d+\.\d+)';$/m)[1];

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/; // 与规则服务的令牌格式一致
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// 把模板开头的说明和 AIN 区块换成新的,其余逻辑原样保留
function withAin(header, ain, strip = false) {
  const start = TEMPLATE.indexOf('const AIN = {');
  const end = TEMPLATE.indexOf('\n};', start) + 3;
  if (start < 0 || end < 3) throw new Error('模板里找不到 AIN 区块');
  // 发给用户的版本去掉模板正文的注释(仓库里的模板保留注释);本地测试版保留
  const body = TEMPLATE.slice(end);
  return header + '\n' + ain + (strip ? stripComments(body) : body);
}

function fail(msg) {
  throw new Error('生成脚本:' + msg);
}

// 规则服务地址:https,允许带路径前缀;本机测试可以用 http://127.0.0.1
function checkServer(value) {
  let url;
  try { url = new URL(String(value)); } catch { fail('规则服务地址无效:' + value); }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('规则服务地址必须是 https(本机测试可用 http://127.0.0.1)');
  if (url.username || url.password || url.search || url.hash) fail('规则服务地址不能带账号、查询参数或 #');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// 设备名只出现在一行注释里:去掉所有换行和控制字符,不然可以换行写出代码
function cleanName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 40) || '未命名设备';
}

function isOlder(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}

/**
 * @param {object} o
 * @param {string} o.server      规则服务地址,例如 https://rules.example.com
 * @param {string} o.token       设备令牌
 * @param {string} o.checkDomain 自检域名,例如 check.example.com
 * @param {string} o.homeRegion  本地直连的国家代码,例如 CN、US
 * @param {'split'|'ai-only'} [o.mode='split']
 * @param {'auto'|'direct'} [o.front='auto']  'direct' = 直连独享 · 静态 ISP 代理 IP,不经订阅节点
 * @param {{auth?:boolean, verify?:boolean, pay?:boolean}} [o.links]  附属链路,默认全开
 * @param {string} [o.deviceName]
 * @param {Date} [o.now]
 * @returns {string} 可直接粘贴到 Clash Verge Rev「扩展脚本」的完整内容
 */
function generateScript(o = {}) {
  const server = checkServer(o.server);
  if (!TOKEN_RE.test(String(o.token))) fail('设备令牌格式不对');
  const checkDomain = String(o.checkDomain || '').toLowerCase();
  if (!HOST_RE.test(checkDomain)) fail('自检域名无效:' + o.checkDomain);
  const homeRegion = String(o.homeRegion || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(homeRegion)) fail('本地地区要用两位国家代码,例如 CN、US');
  const mode = o.mode ?? 'split';
  if (mode !== 'split' && mode !== 'ai-only') fail('分流模式只能是 split 或 ai-only');
  const front = o.front ?? 'auto';
  if (front !== 'auto' && front !== 'direct') fail('前置只能是 auto 或 direct');
  const links = { auth: true, verify: true, pay: true };
  for (const k of Object.keys(o.links || {})) {
    if (!(k in links)) fail('未知的附属链路:' + k);
    links[k] = Boolean(o.links[k]);
  }
  const now = o.now instanceof Date ? o.now : new Date();
  const ruleBase = server + '/v1/' + o.token;

  const header = [
    `// AI Network · AI 网络增强脚本(Clash Verge Rev 扩展脚本)v${SCRIPT_VERSION}`,
    '// Claude、ChatGPT、Gemini(含 Google AI Studio)共用同一个独享 · 静态 ISP 代理 IP',
    `// 设备:${cleanName(o.deviceName)} · 生成时间:${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '//',
    '// © AI Network(ainetid.com)· 由平台按账号和设备生成,仅限本账号的设备使用。禁止分享、转售或用于其他服务:',
    '//   同一份脚本在多处使用会被自动停用并重置凭据;独享 IP 被多人使用会被 AI 服务判定为异常,影响的是你自己的账号。',
    '// 本脚本含这台设备的令牌(不含独享 · 静态 ISP 代理 IP 的账号密码),不要发给别人;泄露时在插件里重置这台设备。',
    '// 粘贴到:Clash Verge Rev → 订阅 → 右键当前订阅 → 扩展脚本 → 保存。可以重复粘贴,不会叠加。',
    '// 浏览器开系统代理即可;桌面客户端需要在 Clash Verge Rev 里开启 TUN 模式。',
    '',
  ].join('\n');

  const q = JSON.stringify;
  const ain = [
    'const AIN = {',
    '  // 平台按账号和设备生成,请勿手改;分流设置在插件里修改后重新复制',
    `  ruleBase: ${q(ruleBase)},`,
    `  checkDomain: ${q(checkDomain)},`,
    '  proxy: null,',
    `  mode: ${q(mode)},`,
    `  homeRegion: ${q(homeRegion)},`,
    `  front: ${front === 'auto' ? q('auto') : 'null'},`,
    '  services: { claude: true, chatgpt: true, gemini: true },',
    `  links: { auth: ${links.auth}, verify: ${links.verify}, pay: ${links.pay} },`,
    '};',
  ].join('\n');

  const out = withAin(header, ain, true);

  // 编译并取出 AIN,确认写进去的就是输入的值
  const context = { module: { exports: {} } };
  vm.createContext(context);
  vm.runInContext(out, context, { filename: 'ai-network-script.generated.js' });
  const got = context.module.exports.AIN;
  if (got.ruleBase !== ruleBase || got.checkDomain !== checkDomain || got.homeRegion !== homeRegion || got.mode !== mode) {
    fail('生成结果与输入不一致');
  }
  return out;
}

module.exports = { generateScript, withAin, stripComments, isOlder, SCRIPT_VERSION, TEMPLATE };

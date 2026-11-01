// 由 ai-network-script.js 生成本地测试版:出口信息直接写在脚本里,不依赖规则服务。
// 模板改动后重新运行:npm run make-local(测试会检查本地测试版是否与模板同步)
const fs = require('fs');
const path = require('path');
const { withAin } = require('./generate.js');

const OUT = path.join(__dirname, 'ai-network-script.local.js');

const header = `// AI Network · 本地测试版(Clash Verge Rev 扩展脚本)
// 由 ai-network-script.js 生成,请勿直接修改逻辑部分;模板改动后运行 node make-local-script.js 重新生成。
//
// 用法:
//   1. 只需要填写下面「出口信息」里的 4 项(协议不对再改 type)
//   2. Clash Verge Rev → 订阅 → 右键当前订阅 → 扩展脚本 → 粘贴全部内容 → 保存
//   3. 代理组「AI Network 专用」里是你的独享 · 静态 ISP 代理 IP;它经过订阅原有的代理组连接(前置代理)
//   4. 浏览器打开 https://claude.ai/cdn-cgi/trace 和 https://chatgpt.com/cdn-cgi/trace,ip= 应等于你的独享 · 静态 ISP 代理 IP
//
// 本文件含出口密码,不要发给别人。只接管 AI 相关流量,其余网站保持订阅原有规则。
`;
const ain = `const AIN = {
  // ================= 出口信息:只需要填这里 =================
  proxy: {
    type: 'socks5',            // 供应商给的协议:socks5 或 http
    server: '填写出口IP或域名',
    port: 0,                   // 填写端口,纯数字,例如 10000
    username: '填写用户名',
    password: '填写密码',
    udp: true,
  },
  // ========================================================

  ruleBase: null,         // 本地测试不连规则服务,只用脚本自带的域名列表
  checkDomain: null,
  mode: 'ai-only',        // 只接管 AI 相关流量,其余保持订阅原有规则
  homeRegion: 'CN',
  front: 'auto',          // 经订阅兜底规则所用的代理组连接独享 · 静态 ISP 代理 IP;改成 null 则直连独享 · 静态 ISP 代理 IP
  services: { claude: true, chatgpt: true, gemini: true },
  links: { auth: true, verify: true, pay: true },
};`;

function buildLocalScript() {
  return withAin(header, ain);
}

if (require.main === module) {
  fs.writeFileSync(OUT, buildLocalScript());
  console.log('已生成 ai-network-script.local.js');
}

module.exports = { buildLocalScript, OUT };

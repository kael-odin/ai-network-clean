# 验收记录

环境：Windows 10 22H2 · Electron 44.8.0 · mihomo v1.19.32

> 文中所有 IP 都是文档示例地址（`203.0.113.x` / `198.51.100.x` / 本机回环），不是真实线路。

## 1. 静态检查

```
npx tsc -p apps/desktop         → exit 0（无错误、无 unused）
node apps/desktop/scripts/check-config.mjs → 28 项断言全部通过
npm -w ain-clean run build      → main 255KB / preload 2.5KB / renderer 265KB + 11KB CSS
```

配置自检覆盖：

| 场景 | 断言 |
|---|---|
| 静态 IP + 订阅 + 经节点 | 静态 IP 写进 `proxies`；有 `AI 专用出口`/`AI 放行`/`普通代理`/`AI 前置`；`claude.ai → AI 放行`；无远端下发节点；DNS 策略把 AI 域名指到 `#AI 专用出口`；TUN 开 IPv6、接管 53；开 `find-process-mode` |
| 静态 IP 直连 | 无 `AI 前置`；节点无 `dialer-proxy` |
| 只有订阅 | 无 AI 组/闸门；`claude.ai → 普通代理`；QUIC 拦截仍在；无占位节点残留；只有订阅节点集 |
| 什么都没有 | `普通代理` 兜底 `DIRECT`（不会变 `COMPATIBLE` 直连） |
| ChatGPT/Gemini 改走节点 | 规则与 DNS 一起改；Grok/Meta 选静态 IP 才加规则 |

## 2. 本地代理端到端

用一个本地 SOCKS5（直接转发）代替静态 IP，配一条测试订阅：

```
连接前系统代理: 0x0 127.0.0.1:7897
连接: connected | 模式 proxy | 出口 198.51.100.23（== 期望出口）
闸门: done | 站点: [Claude 198.51.100.23]
系统代理(连接中): 0x1 127.0.0.1:17897     ← 真的接管了

分流测试:
  ai      Claude   ok  实际=ip      应=ip
  ai      ChatGPT  ok  实际=ip      应=ip
  ai      Gemini   ok  实际=ip      应=ip
  foreign Google   ok  实际=node    应=node
  foreign YouTube  ok  实际=node    应=node
  foreign GitHub   ok  实际=node    应=node
  cn      百度 / B站 / 淘宝 ok 实际=direct 应=direct

诊断: 网络组件 ok · 静态 IP 可用 ok · 出口验证 ok
断开后系统代理: 0x0 127.0.0.1:7897       ← 精确还原
断开后: 保护状态清空，sysproxy/sysdns 备份文件删除
```

截图见仓库 `assets/readme/screenshots/`（演示配置，不含真实线路）。

## 3. 两条常见拓扑

**A. 机器上已有 Clash 之类的 TUN**

```
外部 TUN 检测 : Meta(Meta Tunnel)
连接          : connected / proxy 模式
出口 IP        : 203.0.113.10（= 期望出口）
AI 闸门        : done
分流           : Claude/ChatGPT/Gemini 实际=ip；国外=node；国内=direct
系统代理       : 连接中 0x1/17897 → 断开 0x0/7897
```

**B. 机器上没有 TUN，让客户端自己经订阅节点到静态 IP**

```
配置            : 勾「经节点连接」+ 固定一个能到静态 IP 的节点
自检            : 端口连通 → SOCKS5 握手/认证 → CONNECT 成功
连接            : connected / 本地代理模式 / 出口 203.0.113.10
AI 闸门         : done
分流            : Claude/ChatGPT/Gemini 实际=ip；国外=node；国内=direct
外部 TUN 检测   : 无（物理网卡不再误报）
```

结论：客户端可以完全脱离 Clash 运行。中转节点要挑一个不被静态 IP 供应商拒绝的来源 IP——
同一供应商，不同节点结果可能不同，这是供应商侧的放行策略，不是客户端问题。

## 4. 身份隔离

离线测试 `node apps/desktop/scripts/test-identities.mjs`，全部在临时目录里跑，不碰真实 `~/.claude`：

```
[1] 初始状态：没有身份 / 检测到真实位置有数据                     ✓
[2] 归档 A：真实位置只剩 .ain-identity 记号，业务数据被搬走        ✓
[3] 切回 A：真实位置是 A 的会话，B 的会话不在真实位置              ✓
[4] 再切 B：真实位置换成 B 的会话                                  ✓
[5] 重命名 / 拒绝删除当前身份 / 删除非当前身份                     ✓
[6] 状态文件丢失：靠 meta.json + 记号仍能切回；孤儿数据不丢        ✓
[7] Claude 正在运行时拒绝切换，并提示先结束进程                    ✓
```

实机也做过一次归档 + 切回 + 回滚：真实位置只剩身份记号，切回后会话、`.claude.json`、桌面版数据完整。

## 5. Cloudflare 挑战修复

**现象**：打开 Claude 一直跳 CF 验证，永远过不去。

**根因**：挑战脚本从 `*.challenges.cloudflare.com` 的**子域名**加载，而规则只精确匹配
`challenges.cloudflare.com`，子域名落到 `MATCH`（普通代理组）——主页面和挑战脚本两个出口 IP，
CF 判定环境不一致，无限挑战。

**修复**：在 AI 放行组之前加一条后缀规则，绕过闸门（挑战资源必须无条件可达）：

```
DOMAIN-SUFFIX,challenges.cloudflare.com,<有线路时 AI 专用出口 / 无线路时普通代理>
```

**验收**（真浏览器，不是内核日志自证）：系统 Edge 以 `--proxy-server=http://127.0.0.1:17897` 打开 `https://claude.ai/new`：

```
标题      : 登录 - Claude
正文关键串: 试用 Claude / 使用 Google 继续 / 使用 Apple 继续
内核日志  : 所有 challenges.* 命中 DomainSuffix(challenges.cloudflare.com) using AI 专用出口
```

配套调整：网页版主按钮改为「用默认浏览器」；设置 → 维护新增「设置备份」，保留最近 5 份、可一键恢复，
恢复前先快照当前设置。

## 6. TUN 实测（管理员）

用 `tools/tun-test.mjs` 跑完整流程：连接 → 采样 → 保持 → 断开 → 核对还原。
脚本独立运行、自带兜底断开。

```
虚拟网卡 : Meta|Meta Tunnel
物理网卡 : 以太网|198.18.0.2                ← DNS 被接到内核(fake-ip 网段)
默认路由 : Meta|198.18.0.2|0 ; 以太网|10.0.8.1|256
系统代理 : ProxyEnable=0                    ← TUN 下不再改系统代理
出口     : 203.0.113.10
gstatic  : 204       baidu : 200
claude.ai: 198.18.0.9                       ← fake-ip 生效
trace    : ip=203.0.113.10                  ← 走默认路由看到的出口
```

六项防护（TUN 下的真实结论）：

```
ip       ok  AI 网站看到的是 203.0.113.10
dns      ok  所有在线网卡的 DNS 都指向客户端，查询只能进虚拟网卡
route    ok  虚拟网卡在用；网络组件退出会先拦 AI 再自动重连
ipv6     ok  没有公网 IPv6，不会从 IPv6 泄露
webrtc   ok  STUN 请求被拦下
conflict ok  没有别的代理/VPN 抢流量
AI 核对  ok  Claude:203.0.113.10
```

断开后逐项核对，与连接前一致：虚拟网卡消失、DNS/默认路由/系统代理还原、网络正常、
无 `sysdns-backup.json` 遗留、无内核残留进程。

## 7. 打包与已知限制

```
apps/desktop/release/AI-Network-Clean-Setup-0.1.0.exe
135,505,056 字节（129.2 MB）· SHA-256 5FE846AB70511895F95C1E65336EBB657D5BE493A95F5F2C2C4224F5308EDE9E
```

本次包的变化：

- 不再打包 `node_modules`（主进程已由 esbuild 完整打包，运行时不需要）。
- 应用 Electron fuses：关闭 `NODE_OPTIONS` / `--inspect` 注入入口，`onlyLoadAppFromAsar`。
- 构建时把内核哈希写进 `dist/main/kernel.sha256`，启动前核对；打包版不读 `AIN_MIHOMO_BIN` / `AIN_USER_DATA`。

- 安装包不包含源码映射（`dist/**/*.map` 已排除）。
- NSIS 向导式、按用户安装；应用本体 `requestedExecutionLevel=highestAvailable`（TUN 需要，启动会弹 UAC）。
- 安装包未签名，SmartScreen 可能提示。
- 只支持 Windows；不提供静态 IP、订阅或任何线路。
- 不保证不被封——风控由服务方决定，客户端只负责出口一致、环境一致、不泄露。
- 渲染层没有单元测试，验收靠实跑与截图。

## 7.1 TUN 与 Clash 并存

以前只要 `clash-verge` 之类的进程在任务列表里，就放弃 TUN 退回本地代理——即使 Clash 的 TUN 和系统代理开关都关着、根本没接管流量。退回本地代理后，浏览器以外的程序（Claude 桌面版和里面的 Claude Code）不一定走静态 IP。

现在按「实际占用」判断：只有别的代理/VPN 隧道网卡在线并占着默认路由时才退回本地代理；进程在跑但没接管流量时照常起 TUN，只提示一句。真起不来时内核日志有 `Start TUN listening error`，仍会自动降级。

用本机真实状态验证（Clash Verge 开着、开关全关）：新判定选 TUN。

复跑：

```bash
npm -w ain-clean run typecheck
npm -w ain-clean test                       # 9 项回归测试（身份、恢复、TUN 决策、系统还原）
node apps/desktop/scripts/check-config.mjs
node apps/desktop/scripts/test-identities.mjs
# TUN 实测需管理员启动并开调试端口，然后：
node tools/tun-test.mjs 9336 tun-test
```


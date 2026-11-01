# 验收记录

时间:2026-10-31 · 环境:Windows 10 22H2 · Electron 44.8.0 · 内核 mihomo(官方包内那份,`+dirty` 构建)

## 1. 静态检查

```
npx tsc -p apps/desktop         → exit 0(无错误、无 unused)
node scripts/check-config.mjs   → 28 项断言全部通过
npm -w ain-clean run build      → dist/main/index.cjs 255KB / preload 2.5KB / renderer 265KB+11KB CSS
```

配置自检覆盖:

| 场景 | 断言 |
|---|---|
| 静态 IP + 订阅 + 经节点 | 静态 IP 写进 `proxies`;有 `AI 专用出口`/`AI 放行`/`普通代理`/`AI 前置`;`claude.ai → AI 放行`;无 `ain-ip` 下发节点;DNS 策略把 AI 域名指到 `#AI 专用出口`;TUN 开 IPv6、接管 53;开 `find-process-mode` |
| 静态 IP 直连 | 无 `AI 前置`;节点无 `dialer-proxy` |
| 只有订阅 | 无 AI 组/闸门;`claude.ai → 普通代理`;QUIC 拦截仍在;无占位节点残留;只有订阅节点集 |
| 什么都没有 | `普通代理` 兜底 `DIRECT`(不会变 `COMPATIBLE` 直连) |
| ChatGPT/Gemini 改走节点 | 规则与 DNS 一起改;Grok/Meta 选静态 IP 才加规则 |

## 2. 端到端(本地静态 IP 替身 + 真实订阅)

用一个本地 SOCKS5(直接转发)代替静态 IP,订阅用真实机场(46 节点):

```
连接前系统代理: 0x0 127.0.0.1:7897
连接: connected | 模式 proxy | 线路 true | 出口 198.51.100.23(== 期望出口)
闸门: done | 站点: [Claude 198.51.100.23]
系统代理(连接中): 0x1 127.0.0.1:17897     ← 真的接管了
分流测试:
  ai      Claude   ok  实际=ip      应=ip
  ai      ChatGPT  ok  实际=ip      应=ip
  ai      Gemini   ok  实际=ip      应=ip
  foreign Google   ok  实际=node    应=node
  foreign YouTube  ok  实际=node    应=node
  foreign GitHub   ok  实际=node    应=node
  foreign 国外出口  ok  实际=node    应=node
  cn      百度/ B 站/淘宝 ok 实际=direct 应=direct
诊断: 网络组件 ok · 静态 IP 可用 ok · 出口验证 ok · AI 服务可达 warn(个别站点被本地网络拦)
断开后系统代理: 0x0 127.0.0.1:7897       ← 精确还原
断开后: 保护状态清空
```

截图:见仓库 `assets/readme/screenshots/`(演示配置,不含真实线路)。

收尾检查:断开后系统代理回到 `0x0 / 127.0.0.1:7897`(接管前状态),`sysproxy-backup.json` / `sysdns-backup.json` 都已删除。

## 2.1 本轮新增能力(CCBaga 借鉴 + 全链路)

| 能力 | 验证方式 | 结果 |
|---|---|---|
| 环境一致性核验 | 连接后读 cloudflare trace 的 `loc`,与 `Intl` 时区 / `Get-Culture` 语言比对 | 实测抓到真实矛盾:出口 `CN` / 时区 `Asia/Hong_Kong` / 语言 `en` → 判为「有矛盾」 |
| Claude 残留扫描 | 扫描 `~/.claude` 与 `%APPDATA%\Claude` 的白名单目录 | 扫出 320MB(会话历史 305MB + 文件历史 13.5MB + 终端快照 1.1MB …),按会话/缓存/登录三组展示 |
| 残留清理 | 先备份到 `<userData>\claude-backup-<时间>` 再删;路径必须落在白名单根下 | 本次未执行删除(用户数据),只验证了扫描与路径校验 |
| 从客户端启动 Claude | Claude Code(新终端带 `HTTP(S)_PROXY`)、桌面版(spawn 继承 env)、网页版(内置窗口 `session.setProxy`) | 网页窗口实测加载到 `claude.ai` 并返回地区限制页(当前替身出口在 CN),证明流量确实经内核 |
| 子进程绕过提示 | 代理模式 + 检测到桌面版在跑 | 首页与 Claude 页都出现提示(截图 home.png) |
| 静态 IP 自检 | 端口连通 → 协议 → 认证 → CONNECT,四步 | 见下节:能准确区分「节点连不到」「密码错」「IP 被拦」「静默丢弃」 |

界面精修:设计令牌重写(对比度 ≥4.5:1)、卡片只保留描边 elevation、统一 32/34px 控件高度、SVG 图标替换 Unicode 字形、
滚动条/选区/焦点环/caret 全部主题化;`impeccable detect` 结果 `[]`(无告警)。

## 2.2 真实静态 IP 全链路(2026-10-31 深夜,已通过)

配置:`SOCKS5 / 203.0.113.10:5388 / 账号密码`,`期望出口 203.0.113.10`,不勾「经节点」。
环境:Clash Verge 的 TUN 开着(Meta 网卡占默认路由),客户端自动退回本地代理模式。

```
外部 TUN 检测 : Meta(Meta Tunnel)      ← 客户端能识别「直连其实是经 Clash 出去」
连接          : connected / proxy 模式
静态 IP 可用   : true
出口 IP        : 203.0.113.10(= 期望出口,AI 网站看到的就是它)
AI 闸门        : done(防护通过后放行)
防护           : 静态IP ok · DNS ok · IPv6 ok · WebRTC 异常(代理模式拦不住 UDP,只提醒不拦)
分流           : Claude/ChatGPT/Gemini 实际=ip;国外=node(203.0.113.21);国内=direct
系统代理       : 连接中 0x1/17897,断开后 0x0/7897(精确还原)
```

截图:见仓库 `assets/readme/screenshots/`(演示配置,不含真实线路)。

> 关键纠正:这条代理是 **SOCKS5**。我最初的 HTTP 探测收到 `HTTP/1.1 403 ip forbidden`,
> 误判为「HTTP 代理 + IP 白名单」;实际那是供应商边缘 WAF 对非允许来源的拒绝页。
> 用 SOCKS5 一次就通。详见 [STATIC-IP.md](STATIC-IP.md) 第 8–10 节。

## 2.3 不依赖 Clash 的拓扑(2026-10-31 晚,已通过)

条件:Clash Verge **完全退出**(无 Meta 网卡、无 clash 进程),由客户端自己用订阅节点做中转。

```
配置            : SOCKS5 203.0.113.10:5388,勾「经节点连接」,固定节点 日本节点A
自检(1 次)      : 端口连通 OK → SOCKS5 问候+认证 OK → CONNECT 成功
连接            : connected / 本地代理模式(非管理员)/ 线路 true
出口 IP         : 203.0.113.10(= 期望出口)
AI 闸门         : done
分流            : Claude/ChatGPT/Gemini 实际=ip(203.0.113.10)
                  国外=node(203.0.113.31) · 国内=direct
系统代理        : 连接中 0x1/17897 → 断开 0x0/7897
外部 TUN 检测   : 无(物理网卡不再被误报,已修)
```

结论:**客户端可以完全脱离 Clash 运行**。中转节点必须挑一个不在供应商黑名单里的
(`203.0.113.31` 可用;`203.0.113.21` 与家宽被拦)。

## 2.4 身份隔离(离线测试,7 组全过)

`node apps/desktop/scripts/test-identities.mjs` —— 全部在临时目录里跑,不碰真实 `~/.claude`:

```
[1] 初始状态:没有身份 / 检测到真实位置有数据                     ✓
[2] 归档 A:真实位置只剩 .ain-identity 记号,业务数据被搬走(非复制)  ✓ 槽里 4 个文件
[3] 切回 A:真实位置是 A 的会话,B 的会话不在真实位置               ✓ .claude.json 也是 A 的
[4] 再切 B:真实位置换成 B 的会话,A 的会话不在真实位置              ✓
[5] 重命名 / 拒绝删除当前身份 / 删除非当前身份                     ✓
[6] 状态文件丢失:靠 meta.json + 记号仍能切回 A;孤儿数据不丢        ✓
[7] Claude 正在运行时拒绝切换,并提示先结束进程                    ✓
```

界面上:「身份」页显示当前身份、真实位置数据量、Claude 进程状态,支持归档/切换/重命名/删除。
归档前若 Claude 在跑,会拦下并给「结束 Claude 并重试」按钮。

## 2.5 吸收 clash-verge-rev 的两处改进(2026-10-31 晚)

| 改进 | 来源 | 我们做了什么 |
|---|---|---|
| **PAC 与全局代理的相互干扰** | `src-tauri/src/core/sysopt.rs`:`Disabling PAC clears WinINET proxy flags on Windows, so pure global proxy mode must clear PAC before enabling Sysproxy` | `take()` 接管系统代理时**一并清空 `AutoConfigURL`**,`restore()` 写回;`pointsTo()` 把"有 PAC"也算作未接管,30 秒快检会自动重设 |
| **定时任务** | `src-tauri/src/core/timer.rs` | 连上后每 6 小时**自动重拉订阅**(机场节点/到期状态会变),失败静默、下一轮再试 |

另外两处体验修正:
- 身份列表的尺寸改为**缓存到 `meta.json`**,只有点「重新统计」才全量扫描(之前进页面要扫 4 万文件,界面卡在"读取中")
- 按钮高度统一到 34px 与输入框对齐,"经节点连接静态 IP"从并排改成整行开关卡

## 3. 真实静态 IP 的验证(被供应商拦)

用你给的 `203.0.113.10:5388` 实测,**客户端链路本身是通的**,但供应商拒绝:

| 路径 | 供应商回复 |
|---|---|
| 本机直连(出口 198.51.100.23) | `ip forbidden, ip banned access, ip=198.51.100.23` |
| 经香港/日本/新加坡/台湾/韩国节点 | `connect to proxy error`(节点连不到 5388) |
| 经美国节点 | `ip forbidden, ip banned access, ip=203.0.113.21` / `.21.22` |
| 不带认证 | `ip forbidden, userip=…, info=ip not in allowIpList` |
| 带错误密码 | `user forbidden, user=demo-user, info=account password authentication failed` |
| 之后(探测过多) | 所有来源变成**静默丢弃**:TCP 通、无任何 HTTP/SOCKS5 响应 |

结论与处置见 [STATIC-IP.md](STATIC-IP.md)。**协议探测确认 5388 是 HTTP 代理**(向它发 SOCKS5 问候会收到 `HTTP/1.1 403`)。

## 4. 打包

```
apps/desktop/release/AI-Network-Clean-Setup-0.1.0.exe   135,560,396 B
sha256 920b389efc4d4a7623de72315a50929f604b694e7d128074d7f63623b72f58d1
```

`win-unpacked/resources/`:
`app.asar` 2.2MB(65 个条目) + `mihomo.exe` 61MB + `Country.mmdb`/`geoip.dat`/`geosite.dat` 28MB + `elevate.exe`。

安装包是 NSIS 向导式、按用户安装(不需要管理员装),应用本体 `requestedExecutionLevel=highestAvailable`(TUN 需要,启动会弹 UAC)。

## 4.1 本轮复查

```
npx tsc -p apps/desktop           → exit 0
node scripts/check-config.mjs     → 28 项断言全部通过
impeccable detect --json …        → []（无告警）
断开连接后系统代理               → ProxyEnable 0x0（还原）
```

## 5. 已知限制

- 虚拟网卡(TUN)模式没在本次跑通:测试用的 `electron.exe` 不是管理员,环境里 Clash Verge 也在跑,客户端按设计自动降级为本地代理模式。它是官方逐字节相同的代码路径,官方在管理员下可用。
- 渲染层没有单元测试,验收靠实跑 + 截图。
- 静态 IP 的 `经节点` 模式在配置层验证过(`AI 前置` + `dialer-proxy`),真实链接受供应商限制未能跑通一次成功用例。

## 2.6 身份切换实机演示（真实数据，2026-10-31 晚）

用户关闭全部 Claude 进程后，拿**真实数据**做了一次归档 + 切回（都在 C: 盘，同盘改名）：

```
[0] 基线            真实位置 903.3 MB / 40227 文件 · 账号 a1b2c3d4
[1] 归档「主号」     槽内 903.3 MB / 40226 文件 · 账号 a1b2c3d4
                    真实位置 0.0 MB / 1 文件（只剩身份记号）   ← 业务数据确实搬走了
[2] 切回「主号」     真实位置 903.3 MB / 40227 文件 · 账号 a1b2c3d4
                    身份列表：主号(当前)
[3] 清理上一轮空身份  成功
```

独立核对文件系统：

```
~/.claude                 35492 文件 / 680.7 MB   projects 21 项   .claude.json 存在
~/.claude/.ain-identity   lr759lin（指向当前身份）
<数据目录>/identities/lr759lin   1 文件 / 0 MB（数据在真实位置，槽是空的）
```

> 应用里显示的 903MB 比磁盘上 `.claude` 的 680MB 大，是因为身份包含三处：
> `~/.claude` + `~/.claude.json` + `%APPDATA%\Claude`（桌面版）。

## 2.7 吸收 CV 的第二批（2026-10-31 晚）

| 改进 | 说明 |
|---|---|
| **设置自动备份**（CV `core/auto_backup.rs` 思路） | 每次保存设置前留一份到 `<数据目录>\backups\settings-<时间>.json`，只留最近 5 份 |
| **内置窗口跟随出口地区** | 打开 Claude 网页窗口时用 CDP `Emulation.setTimezoneOverride/setLocaleOverride` 把时区/语言调到出口国家（可在设置里关） |
| **身份页两段式加载** | 先秒开（用 `meta.json` 缓存），再后台补真实位置的完整统计；当前身份的尺寸显示真实位置的数据量（否则槽是空的，像丢了） |

### 内置窗口跟随出口地区（实测）

```
连接          : connected · 出口 203.0.113.10 · 出口国家 US
打开网页窗口   : 立即返回（不再等 loadURL）
               detail = 时区/语言将按出口国家设为 America/New_York / Accept-Language: en-US
网页窗口实测   : Intl.DateTimeFormat().resolvedOptions().timeZone = America/New_York   ✅
```

已知限制：Electron 里 `Emulation.setLocaleOverride` 不生效（`navigator.language` 仍是系统语言），
所以改用 `Emulation.setUserAgentOverride` 的 `acceptLanguage`——**服务端收到的 Accept-Language 是目标语言**，
页面内 JS 读到的 `navigator.language` 仍是系统值。要连 `navigator.language` 一起改，只能给整个应用加
`--lang` 启动参数（会让界面也变成英文），权衡后没做。

## 2.8 第三批优化（2026-11-01）

| 改动 | 验证 |
|---|---|
| **身份卡片补“哪个号”的线索**：账号标识（userID 前 8）、项目数、最后活跃时间 | 实测显示 `903 MB · 40227 文件 · 21 个项目 · 最后活跃 9 小时 51 分前` |
| **日志页可搜索**：按内容/类型/域名/程序过滤三个标签页 | 搜索框与标签同一行对齐；无匹配时显示“没有匹配的记录” |
| **节点页收藏置顶 + 排序**：☆ 收藏、默认/按延迟/按名称 | 收藏项永远排在前面，可一键清空收藏 |
| **订阅行布局修复**：名称+状态一行、链接+显示一行、操作按钮右侧 | 之前名称框被挤成 3 个字、链接换三行 |

安装包：`1e4f1c11…bdc48e6`。

### 本轮修掉的两个语义 bug

1. **归档后当前身份显示成"1 个文件"**：因为"当前身份显示真实位置的量"，而数据刚搬进槽里。
   改成取「槽」与「真实位置」的**较大者**——刚归档显示槽内量，日常使用显示真实位置量。
2. **快路径里 `live.claude` 判定**用的是文件数（缓存为 0 时误报没数据），改成按目录**是否存在**判断。

离线测试 7 组重新全过；安装包最终为 `1e4f1c11…bdc48e6`。

## 2.9 Cloudflare 死循环修复与入口调整（2026-11-01 晚）

### 现象与根因

一打开 Claude 就一直跳 CF 验证、永远过不去。内核日志给出了直接证据：

```
[TCP] ... --> brunhild.challenges.cloudflare.com:443
match Match using 普通代理        ← 挑战页脚本走了另一个出口 IP
[TCP] ... --> challenges.cloudflare.com:443
match DomainSuffix(challenges.cloudflare.com) using AI 专用出口
```

CF 的挑战脚本从 `*.challenges.cloudflare.com` 的**子域名**加载，而原规则只精确匹配
`challenges.cloudflare.com`，子域名落到 `Match`（普通代理组），于是「主页面一个 IP、挑战脚本另一个 IP」——
CF 判定环境不一致，无限挑战。详细分析见 `docs/STATIC-IP.md` §13。

### 修复

在 AI 放行组之前的规则里加一条后缀规则，**绕过门禁**（挑战资源必须无条件可达）：

```
DOMAIN-SUFFIX,challenges.cloudflare.com,<有线路时 AI 专用出口 / 无线路时普通代理>
```

### 验收（真浏览器，不是内核日志自证）

用系统 Edge 以 `--proxy-server=http://127.0.0.1:17897` 直连内核打开 `https://claude.ai/new`：

```
标题      : 登录 - Claude
正文关键串: 试用 Claude / 使用 Google 继续 / 使用 Apple 继续
内核日志  : 所有 challenges.* 命中 DomainSuffix(challenges.cloudflare.com) using AI 专用出口
            没有任何一条落到 Match/普通代理
```

### 入口调整

- Claude 网页版卡片：主按钮改为「用默认浏览器」（真实浏览器指纹，CF 一次过；流量仍走系统代理 → 内核），
  「内置窗口」降为次按钮，悬停说明「不依赖系统代理，但 Cloudflare 常挑战 Electron」。
- 设置 → 维护 → **设置备份**：列出最近 5 份，可一键恢复；恢复前先把当前设置再存一份（恢复也能反悔）。
  备份时间显示为 `2026-11-01 11:19:31`（此前误显示成 `2026 11 01 11 19 31`）。

### 验证记录

```
恢复最早一份  → line 变回 none（符合备份内容）
恢复工作备份  → line 恢复 socks5 203.0.113.10:5388 viaNode=true
磁盘 settings.json 同步为同一条线路
备份列表 4 份，时间戳格式正确
```

安装包：`DC0E2C8C…84F6`（135,580,456 字节）。

## 2.10 TUN 模式实测（2026-11-01 深夜，全部通过）

用 `tools/tun-test.mjs` 跑完整流程：连接 → 采样 → 保持 → 断开 → 核对还原。
脚本独立运行、自带兜底断开（就算和模型的连接断了，它也会按时把网络还回去）。共跑 4 轮：
前两轮失败是**采样时机太早**（防护/真实出口核对是连接后才异步跑的），不是产品问题；修正等待条件后全绿。

### 连接后（管理员 + `tun=auto`）

```
虚拟网卡 : Meta|Meta Tunnel                 ← 出现
物理网卡 : 以太网|198.18.0.2                 ← DNS 被接到内核(fake-ip 网段)
默认路由 : Meta|198.18.0.2|0 ; 以太网|10.0.8.1|256
系统代理 : ProxyEnable=0                    ← TUN 下不再改系统代理
出口     : 203.0.113.10                     ← 期望的静态 IP
gstatic  : 204                              ← 国外通
baidu    : 200                              ← 国内通
claude.ai: 198.18.0.9                        ← fake-ip 生效
trace    : ip=203.0.113.10                  ← 走默认路由(即虚拟网卡)看到的出口
```

### 六项防护（TUN 下的真实结论）

```
ip       ok  AI 网站看到的是 203.0.113.10
dns      ok  所有在线网卡的 DNS 都指向客户端,查询只能进虚拟网卡
route    ok  虚拟网卡「Meta」在用;网络组件退出会先拦 AI 再自动重连
ipv6     ok  没有公网 IPv6,不会从 IPv6 泄露
webrtc   ok  STUN 请求被拦下
conflict ok  没有别的代理/VPN 抢流量
AI 核对  ok  Claude:203.0.113.10
```

### 断开后（逐项核对，与连接前完全一致）

```
Meta Tunnel 消失 · DNS 还原 以太网=114.114.114.114 / WLAN=223.5.5.5
默认路由还原 以太网|10.0.8.1 · 系统代理 ProxyEnable=0 · 网络 200
无 sysdns-backup.json 遗留 · 无 mihomo/electron 残留进程
```

> 注：测试用的管理器权限只批准了一次 UAC；应用清单是 `highestAvailable`（与官方一致），
> 所以正式安装版每次启动都会请求管理员。测试结束后已把设置里的 `tun` 改回测试前的 `off`。

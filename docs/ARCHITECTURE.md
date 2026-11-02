# 架构与数据流

## 1. 运行形态

```
Electron 44.8.0
├─ 主进程 dist/main/index.cjs         (esbuild 打包,~250KB)
├─ 预加载 dist/preload/index.cjs      (contextIsolation + sandbox)
├─ 渲染层 dist/renderer/              (React 19,单 bundle)
└─ 内核   resources/mihomo.exe        (子进程,127.0.0.1:19797 控制接口,17897 混合代理端口)
```

数据目录 `%APPDATA%\ain-clean`:

```
settings.json          设置(明文:含订阅令牌、静态 IP 密码)
connection-log.jsonl   连接日志(5000 条)
anomalies.jsonl        异常连接
sysdns-backup.json     DNS 接管前的原始设置(断开时删除)
sysproxy-backup.json   系统代理接管前的原始设置(断开时删除)
mihomo/config.json     生成的内核配置
mihomo/mihomo.log      内核日志(上一份 mihomo.prev.log)
```

## 2. 模块

| 模块 | 职责 |
|---|---|
| `index.ts` | 窗口/托盘、连接状态机、闸门决策、轮询与漂移监控、IPC |
| `config.ts` | 生成 mihomo 配置:组、规则、DNS、分流,调用 `packages/rules` 模板 |
| `mihomo.ts` | 内核生命周期、控制接口封装、节点/组状态、健康检查探针 |
| `protect.ts` | 出口 IP/DNS/IPv6/WebRTC 四项检测(含自写 STUN) |
| `gate.ts` | 闸门决策:异常立刻拦,未确认连续两轮才拦,本地代理模式下 IPv6/WebRTC 只提醒 |
| `sysdns.ts` | 物理网卡 DNS 接管 + 看守进程 + 崩溃自恢复 |
| `sysproxy.ts` | 系统代理接管/还原(含 PAC 的接管与写回)+ 清理 Clash 残留的死代理 |
| `claudecode.ts` | Claude Code 代理检测、一键修正、断开还原 |
| `claude.ts` | Claude 官方状态、连接前已开着的 Claude、看到的出口 |
| `anomaly.ts` | 解析内核连接日志,认出被拦/漏走/连不上的 AI 连接 |
| `conns.ts` | 连接记录(活动 + 最近断开) |
| `linefail.ts` | 从拨号失败日志判断原因(超时/拒绝/认证/前置节点) |
| `sub.ts` / `subinfo.ts` | 订阅里的提示节点识别、拉取并提取 DNS 策略/hosts |
| `regions.ts` | 按节点名认地区,给内核 url-test 的 filter |
| `diagnose.ts` | 分步诊断(组件 → 节点 → 静态 IP → 出口 → 站点可达) |
| `splittest.ts` | 三条线各测一次,从连接表读实际走的线路 |
| `settings.ts` | 设置读写与校验(非法值退回默认) |
| `claudeenv.ts` | 环境一致性:出口国家 vs 时区/语言/平台(CCBaga 思路) |
| `claudeclean.ts` | Claude 本地残留扫描/备份/清理(白名单路径 + 前缀校验) |
| `launch.ts` | 全链路启动:Claude Code(带代理环境)/ 桌面版 / 内置网页窗口 |
| `linetest.ts` | 静态 IP 自检:先 SOCKS5 后 HTTP,原样带回供应商回复 |
| `identities.ts` | 身份隔离:多套 Claude 数据各自独立,目录改名切换、可回滚 |

## 3. 连接状态机

```
disconnected
   │ connect()  检测:管理员 / 别的虚拟网卡 / 残留系统代理 / 端口占用
   ▼
starting ── 生成 config.json → 启动 mihomo → 等控制接口
   │            ├─ TUN 起来 → sysDns.apply(改网卡 DNS + 起看守进程)
   │            └─ TUN 失败 → 自动降级本地代理模式重启
   │         订阅:拉取 → 等节点 → 测速 → 选节点
   │         静态 IP:探针(/proxies/<节点>/delay),不通则沿订阅节点逐个换前置
   ▼
connected ── 每 20s 查组状态;每 30s 本地快检;每 5 分钟出口核对;每 30 分钟全量防护
   │         内核意外退出 → recover():保留 DNS 接管,自动重连 3 次
   ▼
disconnected(还原 DNS / 系统代理 / Claude Code 设置)
```

## 4. 闸门模型(AI 不被“漏出去”的核心)

内核里三样东西:

| 组 | 类型 | 作用 |
|---|---|---|
| `AI 专用出口` | select,只有一个成员(**你的静态 IP**) | 不可用时不会回退到其他节点 |
| `AI 放行` | select:`REJECT` / `AI 专用出口` | 闸门,启动时默认 `REJECT` |
| `普通代理` / `自动选择` | select / url-test | 你的订阅节点 |

规则:`Claude/ChatGPT/Gemini + 登录 + 人机验证 + 付款 + 公共 DoH + IP 检测站` → `AI 放行`;
`局域网` → DIRECT;`本地国家 GEOIP` → DIRECT;其余 → `普通代理`。

放行条件(`index.ts runChecks`):

1. **静态 IP 出口**:经内核读 Cloudflare trace,必须等于你填的期望出口
2. **DNS 防泄露**:所有在线物理网卡 DNS 都指向内核 TUN 地址、外网路由在 TUN 上(本机机制核对)
3. **IPv6 防泄露**:只有 IPv6 的探测站被内核拦掉
4. **WebRTC 防泄露**:自己发 STUN,外部看到的必须是静态 IP 或请求被拦

四项全过 → `AI 放行` 切到 `AI 专用出口`;任一“异常”立刻拦;仅“未确认”且闸门已开时容忍一轮。

另外每 2 秒读连接表:`AI 域名 + 组不是 AI 出口` = 漏点 → 立刻关闸 + 通知 + 60 秒后复查。

## 5. 设计取舍

| 取舍 | 做法 | 原因 |
|---|---|---|
| 规则来源 | 模板内置域名表(`ruleBase = null`) | 不依赖远端规则服务 |
| 静态 IP | 本地配置写进 `proxies[]` | 用自己的线路 |
| 账号 / 设备 / 订阅 / 支付 / 推荐 / 公告 | 不实现 | 只做客户端 |
| 安装统计 / 活跃上报 / 连接日志上传 / 出口上报 | 不实现 | 无遥测 |
| 自动更新 | 不实现 | 升级由用户决定 |
| DNS 防护核对 | 读本机网卡与路由状态(`evaluateDnsLocal`) | 不依赖第三方探测服务 |
| 本地代理模式 | 真正接管系统代理(含 PAC)并精确还原 | 让代理模式可用 |
| 界面 | React 六页 + 托盘面板 | 可维护 |

## 6. 界面与 IPC

`src/shared/ipc.ts` 是唯一契约:`AppState`(主进程推送)+ `AinApi`(界面调用)。
preload 只暴露这些方法,`contextIsolation: true / sandbox: true / nodeIntegration: false`。
主进程→界面:单个 `state` 事件,全量快照;界面→主进程:约 20 个 `invoke`。

托盘面板与主窗口共用同一份渲染层(`#tray` 哈希渲染紧凑视图)。

## 6.1 全链路(子进程不绕过)

| 入口 | 做法 | 覆盖 |
|---|---|---|
| Claude Code | 新开终端,环境里写 `HTTP(S)_PROXY=http://127.0.0.1:17897` | 该终端里所有进程 |
| 桌面版(非商店版) | 直接 spawn,`env` 带代理 | 主进程 + 渲染进程 + 子进程 |
| 桌面版(商店/MSIX) | 只能用 `shell:AppsFolder` 拉起,环境进不去 | 只有 TUN 能兜住 |
| 网页版 | 内置 `BrowserWindow` + `persist:claude-web` 会话,`session.setProxy` 指向内核 | 该窗口全部流量 |

代理模式下若检测到桌面版在跑,首页与 Claude 页都会提示"子进程可能绕过",并引导用 TUN 或从客户端启动。

## 6.2 身份隔离(多账号不关联)

同一台机器上多个 Claude 账号最容易被关联的地方,是本地数据混在一起。做法:

| 项 | 说明 |
|---|---|
| 隔离对象 | `~/.claude`(Code 的登录/会话/插件/MCP)、`~/.claude.json`、`%APPDATA%\Claude`(桌面版) |
| 存放 | `<数据目录>\identities\<id>\` 下的 `home-claude` / `home-claude.json` / `appdata-claude` |
| 切换 | **同盘目录改名**(rename),不压缩、不加密、不复制、不删除 |
| 目标已存在 | 合并式搬入(逐项 rename),绝不覆盖 |
| 状态丢失 | 每个槽带 `meta.json`;真实数据里还有 `.ain-identity` 记号,启动时以目录为准重建索引 |
| 失败处理 | 按逆序把已搬动的搬回去(回滚) |
| 前置条件 | 切换/归档前必须结束 Claude(桌面版 + 命令行),否则文件被占用且会混数据 |
| 跨盘 | 直接拒绝,不自作主张复制几百 MB |

## 7. 安全边界

- 没有自动更新、没有远程代码路径:外部输入只有订阅正文(内核解析)和网页内容(不出网)
- 诊断报告复制前会遮掉静态 IP 密码、订阅只留主机名
- 订阅链接在界面上默认脱敏(点“显示”才展开)
- `sysdns-backup.json` / `sysproxy-backup.json` 里的值会拼进 PowerShell 命令,读取时逐项校验(防命令注入)
- 静态 IP 的账号密码只写在本机 `settings.json`(和 Clash 存订阅令牌同样的取舍)

### 身份列表的尺寸语义

- **当前身份**：槽是空的（数据在真实位置），列表显示真实位置的量
- **非当前身份**：显示槽内量，缓存自该槽的 `meta.json`
- 页面两段式加载：先出清单，再补完整统计；只有点「重新统计」才强制全量扫描

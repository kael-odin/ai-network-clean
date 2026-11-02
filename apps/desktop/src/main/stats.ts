// 长跑指标:进程起来之后累计发生了什么。
// 目的不是好看,是「开着几天」时能回答三个问题:是不是在反复重连、闸门是不是反复开关、日志是不是在膨胀。
// 不写盘、不上报,只在内存里;诊断报告和「日志」页可以读。
export interface RuntimeStats {
  startedAt: string;
  connects: number;        // 主动 + 自动连接尝试
  connectFailures: number;
  autoRecovers: number;    // 内核意外退出后的自动重连次数
  reconnected: number;     // 自动重连成功次数
  fullChecks: number;      // 完整检测(4 项防护)跑了几次
  lightChecks: number;     // 5 分钟一次的出口核对
  quickChecks: number;     // 30 秒一次的本地快检
  gateOpens: number;
  gateBlocks: number;
  leaks: number;           // 发现 AI 连接没走静态 IP 的次数
  dnsReverts: number;      // DNS 被别的软件改回去、又被指回来的次数
  netChanges: number;
  subRefreshes: number;
  logBytes: number;        // 内核日志当前大小(轮转后归零)
}

export function createStats(): RuntimeStats {
  return {
    startedAt: new Date().toISOString(),
    connects: 0, connectFailures: 0, autoRecovers: 0, reconnected: 0,
    fullChecks: 0, lightChecks: 0, quickChecks: 0,
    gateOpens: 0, gateBlocks: 0, leaks: 0, dnsReverts: 0,
    netChanges: 0, subRefreshes: 0, logBytes: 0,
  };
}

// 报告里要看的是一句话结论,不是一堆数字
export function describeStats(s: RuntimeStats, now = Date.now()): string {
  const hours = (now - Date.parse(s.startedAt)) / 3_600_000;
  const perHour = (n: number) => (hours >= 0.25 ? `(${(n / hours).toFixed(1)}/小时)` : '');
  return [
    `已运行 ${hours.toFixed(1)} 小时`,
    `连接 ${s.connects} 次、失败 ${s.connectFailures}`,
    `内核意外退出 ${s.autoRecovers} 次、自动恢复 ${s.reconnected} 次`,
    `完整检测 ${s.fullChecks} 次 ${perHour(s.fullChecks)}`,
    `闸门开 ${s.gateOpens} / 关 ${s.gateBlocks}${s.leaks ? `、漏走 ${s.leaks} 次` : ''}`,
    s.dnsReverts ? `DNS 被改回 ${s.dnsReverts} 次` : '',
    s.netChanges ? `网络变化 ${s.netChanges} 次` : '',
    `内核日志 ${(s.logBytes / 1024 / 1024).toFixed(1)}MB`,
  ].filter(Boolean).join(' · ');
}

import { useState } from 'react';
import type { AppState } from '../../shared/ipc.ts';
import { ain, fmtBytes, fmtTime, statePill } from '../api.ts';
import { Card, Empty, Pill } from '../components/ui.tsx';

type Tab = 'log' | 'anomaly' | 'conns';

const ANOMALY_TEXT = { blocked: '被拦住', leak: '没走静态 IP', failed: '连不上' } as const;

export function Logs({ state }: { state: AppState }) {
  const [tab, setTab] = useState<Tab>('log');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'all' | 'conn' | 'guard' | 'claude' | 'maint'>('all');
  const [byHost, setByHost] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const exportLog = async () => { setBusy('log'); try { const p = await ain.exportLog(); if (p) await ain.copyText(p); } finally { setBusy(null); } };
  const exportAnomaly = async () => { setBusy('anomaly'); try { const p = await ain.exportAnomalies(); if (p) await ain.copyText(p); } finally { setBusy(null); } };
  const copyDiag = async () => { setBusy('diag'); try { await ain.copyDiag(); } finally { setBusy(null); } };

  const conns = [...state.connections, ...state.closedConns];
  // 按类别归并:日志的 kind 很多,按"连接/防护/Claude/维护"看更清楚
  const GROUPS: Record<Exclude<typeof group, 'all'>, string[]> = {
    conn: ['连接', '已连接', '断开', '连接失败', '换节点', '兼容端口', '意外断开', '恢复', '禁止访问'],
    guard: ['拦截 AI', '放行 AI', '防护复查', '出口验证', '出口核对', '接管 DNS', '恢复 DNS', '接管系统代理', '恢复系统代理'],
    claude: ['Claude 官方状态', 'Claude 已在运行', '启动 Claude', 'Claude 已恢复'],
    maint: ['身份', '静态 IP 自检', '清理 Claude 残留', '指纹', '网络变化', '唤醒', '恢复系统代理'],
  };
  const inGroup = (kind: string) => group === 'all' || GROUPS[group].includes(kind);
  const kw = q.trim().toLowerCase();
  const hit = (...parts: (string | null | undefined)[]) => !kw || parts.some((x) => (x ?? '').toLowerCase().includes(kw));
  const logs = state.log.filter((e) => inGroup(e.kind) && hit(e.kind, e.text));
  const anomalies = state.anomalies.filter((a) => hit(a.proc, a.host, a.reason));
  // 按网站聚合:同一网站被拦/漏走/连不上的次数合起来看
  const anomalyGroups = (() => {
    const m = new Map<string, { host: string; count: number; last: string; kinds: Set<string>; procs: Set<string> }>();
    for (const a of anomalies) {
      const g = m.get(a.host) ?? { host: a.host, count: 0, last: a.last, kinds: new Set<string>(), procs: new Set<string>() };
      g.count += a.count;
      if (a.last > g.last) g.last = a.last;
      g.kinds.add(a.kind);
      if (a.proc) g.procs.add(a.proc);
      m.set(a.host, g);
    }
    return [...m.values()].sort((x, y) => y.count - x.count);
  })();
  const matchedConns = conns.filter((c) => hit(c.host, c.process, c.node, c.service));

  return (
    <div className="grid" style={{ gap: 12 }}>
      <Card
        title="记录"
        hint="只存在本机,不会上传"
        right={(
          <div className="btn-row">
            <button className="btn sm" disabled={busy !== null} onClick={() => void exportLog()}>{busy === 'log' ? '导出中…' : '导出连接日志'}</button>
            <button className="btn sm" disabled={busy !== null} onClick={() => void exportAnomaly()}>{busy === 'anomaly' ? '导出中…' : '导出异常记录'}</button>
            <button className="btn sm primary" disabled={busy !== null} onClick={() => void copyDiag()}>{busy === 'diag' ? '复制中…' : '复制诊断报告'}</button>
          </div>
        )}
      >
        <div className="tabs">
          <button className={`tab ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>连接日志 · {state.log.length}</button>
          <button className={`tab ${tab === 'anomaly' ? 'active' : ''}`} onClick={() => setTab('anomaly')}>异常连接 · {state.anomalies.length}</button>
          <button className={`tab ${tab === 'conns' ? 'active' : ''}`} onClick={() => setTab('conns')}>连接记录 · {conns.length}</button>
          <select className="select" style={{ width: 120, marginLeft: 'auto' }} value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
            <option value="all">全部类别</option>
            <option value="conn">连接</option>
            <option value="guard">防护</option>
            <option value="claude">Claude</option>
            <option value="maint">维护</option>
          </select>
          <input className="input" style={{ maxWidth: 200 }} placeholder="搜索日志 / 域名 / 程序" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        {tab === 'log' ? (
          logs.length === 0 ? <Empty>{kw ? '没有匹配的记录' : '还没有记录'}</Empty> : (
            <div className="log-list">
              {[...logs].reverse().map((e, i) => (
                <div key={`${e.at}-${i}`} className="log-item">
                  <span className="at">{fmtTime(e.at)}</span>
                  <span className="kind">{e.kind}</span>
                  <span className="txt">{e.text}</span>
                </div>
              ))}
            </div>
          )
        ) : null}

        {tab === 'anomaly' ? (
          <>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button className={`btn sm ${byHost ? 'primary' : ''}`} onClick={() => setByHost((v) => !v)}>
              {byHost ? '按网站聚合中' : '按网站聚合'}
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>同一网站被拦/漏走/连不上的次数合起来看</span>
          </div>
          {byHost ? (
            anomalyGroups.length === 0 ? <Empty>没有异常</Empty> : (
              <div className="log-list">
                {anomalyGroups.map((g) => (
                  <div key={g.host} className="log-item bad" style={{ gridTemplateColumns: '56px 1fr' }}>
                    <span className="kind">{g.count} 次</span>
                    <span className="txt">
                      <b className="mono-s">{g.host}</b>
                      <span className="muted"> · {[...g.kinds].map((k) => ANOMALY_TEXT[k as keyof typeof ANOMALY_TEXT] ?? k).join(' / ')}</span>
                      {g.procs.size ? <span className="muted"> · {[...g.procs].join('、')}</span> : null}
                      <span className="muted"> · 最近 {fmtTime(g.last)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : anomalies.length === 0 ? <Empty>{kw ? '没有匹配的异常' : '没有异常连接。被拦住、没走静态 IP、连不上的 AI 连接会出现在这里'}</Empty> : (
            <div className="log-list">
              {anomalies.map((a, i) => (
                <div key={`${a.at}-${i}`} className="log-item bad">
                  <span className="at">{fmtTime(a.last)}</span>
                  <span className="kind">{ANOMALY_TEXT[a.kind]}</span>
                  <span className="txt">
                    <b>{a.proc}</b> → {a.host}
                    {a.reason ? <span className="muted">({a.reason})</span> : null}
                    {a.count > 1 ? <span className="muted">,共 {a.count} 次</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
          </>
        ) : null}

        {tab === 'conns' ? (
          matchedConns.length === 0 ? <Empty>{kw ? '没有匹配的连接' : '没有连接记录(连上后每 20 秒同步一次)'}</Empty> : (
            <div className="scroll-x" style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
              <table className="table">
                <thead><tr><th>时间</th><th>程序</th><th>目标</th><th>线路</th><th>节点</th><th className="right">流量</th></tr></thead>
                <tbody>
                  {matchedConns.slice(0, 300).map((c) => (
                    <tr key={c.id}>
                      <td className="mono-s">{new Date(c.start).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                      <td>{c.process || '-'}</td>
                      <td className="mono-s" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.host}>{c.host}{c.port ? `:${c.port}` : ''}</td>
                      <td>
                        <Pill tone={c.route === 'ip' ? 'ok' : c.route === 'node' ? 'brand' : c.route === 'blocked' ? 'bad' : 'unknown'}>
                          {c.route === 'ip' ? '静态 IP' : c.route === 'node' ? '你的节点' : c.route === 'blocked' ? '已拦截' : '直连'}
                        </Pill>
                        {c.service ? <span className="muted"> · {c.service}</span> : null}
                      </td>
                      <td className="muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.node ?? ''}>{c.node ?? '-'}</td>
                      <td className="right mono-s">{fmtBytes(c.up + c.down)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </Card>

      <Card title="本机文件" hint="日志和配置都在用户数据目录">
        <div className="mono-block">{`connection-log.jsonl   连接日志(最近 5000 条)
anomalies.jsonl       异常连接
mihomo/mihomo.log     内核日志(上一份是 mihomo.prev.log)
settings.json         设置(含订阅链接和静态 IP 密码,明文,和 Clash 一样)
sysdns-backup.json    接管 DNS 前的原始设置(断开时自动删除)`}</div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => void ain.openDataDir()}>打开数据目录</button>
          <span className="muted" style={{ fontSize: 11.5 }}>诊断报告里不含静态 IP 密码,订阅链接只留主机名</span>
        </div>
      </Card>
    </div>
  );
}

export { statePill };

import { useState } from 'react';
import type { AppState, ProtectItem, SplitRow } from '../../shared/ipc.ts';
import { ain, fmtAgo, statePill } from '../api.ts';
import { Banner, Card, Pill } from '../components/ui.tsx';

function ProtCard({ name, item, hintOk }: { name: string; item: ProtectItem | null | undefined; hintOk: string }) {
  const st = item?.state ?? 'unknown';
  const p = statePill(st === 'ok' ? 'ok' : st === 'fail' ? 'fail' : 'unknown');
  return (
    <div className={`card prot ${st}`}>
      <div className="top">
        <span className="nm">{name}</span>
        <span className="st"><Pill tone={p.cls as 'ok' | 'bad' | 'unknown'}>{p.text}</Pill></span>
      </div>
      <div className="dt">{item?.detail || hintOk}</div>
    </div>
  );
}

const laneText = (l: SplitRow['lane']): string => (l === 'ai' ? 'AI' : l === 'foreign' ? '国外' : l === 'cn' ? '国内' : '自定义');
const routeText = (r: SplitRow['route']): string => {
  switch (r) {
    case 'ip': return '静态 IP';
    case 'node': return '你的节点';
    case 'direct': return '直连';
    case 'blocked': return '已拦截';
    case 'outside': return '不经内核';
    default: return '未知';
  }
};
const expectText = (e: SplitRow['expect']): string => (e === 'ip' ? '静态 IP' : e === 'node' ? '你的节点' : '直连');

export function Home({ state }: { state: AppState }) {
  const [splits, setSplits] = useState<SplitRow[] | null>(null);
  const [splitBusy, setSplitBusy] = useState(false);
  const c = state.conn;
  const connected = c.status === 'connected';
  const starting = c.status === 'starting';
  const line = state.settings.line;
  const hasLine = line.type !== 'none' && !!line.server;
  const hasSubs = state.settings.subs.some((s) => s.enabled);
  const blocked = state.aiCheck?.state === 'blocked';

  const connect = async () => { if (connected || starting) await ain.disconnect(); else await ain.connect(); };
  const runSplit = async () => {
    setSplitBusy(true);
    try { setSplits(await ain.splitTest()); } finally { setSplitBusy(false); }
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <section className="card hero-card">
        <div className="hero">
          <button className={`big ${connected ? '' : starting ? 'busy' : 'off'}`} onClick={() => void connect()}>
            <span className="t">{starting ? '连接中' : connected ? '断开' : '连接'}</span>
            <span className="s">{starting ? '请稍候' : connected ? '点击断开' : '未连接'}</span>
          </button>
          <div className="info">
            <div className="row1">
              <span className="title">{connected ? (c.lineUp === false ? '已连接,静态 IP 不可用' : '已连接') : starting ? '正在连接…' : c.status === 'failed' ? '连接失败' : '未连接'}</span>
              <Pill tone={connected ? 'ok' : starting ? 'warn' : c.status === 'failed' ? 'bad' : 'unknown'}>
                <span className="dot-s" />{c.mode === 'tun' ? '虚拟网卡' : '本地代理'}
              </Pill>
              {hasLine ? <Pill tone="brand">AI 走静态 IP</Pill> : <Pill tone="unknown">AI 走节点</Pill>}
              {!state.admin ? <Pill tone="warn">没有管理员权限</Pill> : null}
            </div>
            <div className="kv">
              <div><div className="k">出口 IP</div><div className="v mono">{c.exitIp ?? '-'}</div></div>
              <div><div className="k">期望出口</div><div className="v mono">{line.exitIp || '-'}</div></div>
              <div><div className="k">订阅节点</div><div className="v">{c.node ?? (hasSubs ? '-' : '没有订阅')}</div></div>
              <div><div className="k">已连接</div><div className="v">{connected ? fmtAgo(c.since) : '-'}</div></div>
              <div><div className="k">上一跳</div><div className="v">{c.front ?? (line.viaNode ? '自动' : '直连')}</div></div>
              <div><div className="k">上次检测</div><div className="v">{c.checkedAt ? fmtAgo(c.checkedAt) : '-'}</div></div>
            </div>
          </div>
        </div>

        {c.recovered ? <Banner tone="info">已清理 Clash 留下的残留系统代理(它原本指向 {c.recovered},那个端口已经没人听)</Banner> : null}
        {c.warning ? <div style={{ marginTop: 10 }}><Banner tone="warn">{c.warning}</Banner></div> : null}
        {c.error && !blocked ? <div style={{ marginTop: 10 }}><Banner tone="bad">{c.error}</Banner></div> : null}
        {blocked ? (
          <div style={{ marginTop: 10 }}>
            <Banner
              tone="bad"
              right={<div className="btn-row"><button className="btn sm" onClick={() => void ain.check()}>重新检测</button><button className="btn sm primary" onClick={() => void ain.repair()}>一键修复</button></div>}
            >
              <b>AI 流量已拦截</b>:{state.aiCheck?.reason ?? '防护没有全部通过'}。其他网站照常。
            </Banner>
          </div>
        ) : null}
        {state.aiCheck?.state === 'done' && state.aiCheck.warn ? (
          <div className="hint-line" style={{ marginTop: 10 }}>{state.aiCheck.warn}(只提醒,不影响使用)</div>
        ) : null}
        {connected && c.lineUp === false ? (
          <div style={{ marginTop: 10 }}>
            <Banner tone="bad" right={<button className="btn sm" onClick={() => void ain.repair()}>重试</button>}>
              连不上静态 IP{c.downReason ? `:${c.downReason}` : ''}。AI 流量会被拦住(不会改走节点){c.downSince ? `,已经 ${fmtAgo(c.downSince)}` : ''}。
            </Banner>
          </div>
        ) : null}
        {!hasLine && !hasSubs ? (
          <div style={{ marginTop: 10 }}><Banner tone="info">还没有线路:到「设置」填一条静态 IP,或到「节点」添加订阅</Banner></div>
        ) : null}
        {!hasLine && hasSubs ? (
          <div style={{ marginTop: 10 }}><Banner tone="info">还没填静态 IP:AI 域名会走你的订阅节点。填了以后 AI 只走静态 IP,其他国外网站仍然走节点</Banner></div>
        ) : null}
        {hasLine && !hasSubs && line.viaNode ? (
          <div style={{ marginTop: 10 }}><Banner tone="warn">打开了「经节点连接静态 IP」,但还没有订阅:这一项不会生效</Banner></div>
        ) : null}
      </section>

      <div className="grid c4">
        <ProtCard name="静态 IP 出口" item={state.protect?.ip} hintOk="连上后核对 AI 网站看到的 IP" />
        <ProtCard name="DNS 防泄露" item={state.protect?.dns} hintOk="核对网卡 DNS 是否都指向客户端" />
        <ProtCard name="IPv6 防泄露" item={state.protect?.ipv6} hintOk="检查 IPv6 能不能绕过虚拟网卡" />
        <ProtCard name="WebRTC 防泄露" item={state.protect?.webrtc} hintOk="检查网页能不能拿到真实地址" />
      </div>
      {(state.protect?.route || state.protect?.conflict) ? (
        <div className="tag-line" style={{ marginTop: -2 }}>
          {state.protect?.route ? (
            <span className="chip" title={state.protect.route.detail}>
              断网保护:{state.protect.route.state === 'ok' ? '已接管(网络组件退出时会先拦住 AI)' : '本地代理模式下没有'}
            </span>
          ) : null}
          {state.protect?.conflict ? (
            <span className="chip" title={state.protect.conflict.detail}>
              代理冲突:{state.protect.conflict.state === 'ok' ? '没有别的代理在抢流量' : '检测到别的代理/VPN'}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid c2">
        <Card title="Claude" hint="AI 网站看到的出口">
          <div className="notice-list">
            <div className="tag-line">
              <span className="muted" style={{ width: 92 }}>官方状态</span>
              {state.claudeStatus ? (
                <Pill tone={state.claudeStatus.level === 'ok' ? 'ok' : state.claudeStatus.level === 'maintenance' ? 'warn' : 'bad'}>
                  {state.claudeStatus.level === 'ok' ? '正常' : state.claudeStatus.level === 'maintenance' ? '维护中' : state.claudeStatus.level === 'minor' ? '部分故障' : '故障'}
                </Pill>
              ) : <Pill tone="unknown">未读取</Pill>}
              {state.claudeStatus?.text ? <span className="muted" style={{ fontSize: 11.5 }}>{state.claudeStatus.text}</span> : null}
            </div>
            <div className="tag-line">
              <span className="muted" style={{ width: 92 }}>看到的出口</span>
              {state.aiCheck?.sites?.length ? state.aiCheck.sites.map((s) => (
                <Pill key={s.name} tone={s.ok === false ? 'bad' : s.ok ? 'ok' : 'unknown'}>
                  {s.name} {s.ip ?? '读不到'}
                </Pill>
              )) : <span className="muted">连上后读取</span>}
            </div>
            <div className="tag-line">
              <span className="muted" style={{ width: 92 }}>Claude Code</span>
              {state.claudeCode ? (
                <>
                  <Pill tone={state.claudeCode.state === 'ok' ? 'ok' : 'warn'}>{state.claudeCode.state === 'ok' ? '走客户端' : '需要修正'}</Pill>
                  <span className="muted" style={{ fontSize: 11.5 }}>{state.claudeCode.detail}</span>
                  {state.claudeCode.fixable ? <button className="btn sm" onClick={() => void ain.ccFix()}>一键修正</button> : null}
                  {state.claudeCode.fixed ? <button className="btn sm ghost" onClick={() => void ain.ccUndo()}>撤销修正</button> : null}
                </>
              ) : <span className="muted">连上后检测</span>}
            </div>
            {state.claudeApps ? (
              <Banner tone="warn" right={<button className="btn sm" onClick={() => void ain.claudeDismiss()}>知道了</button>}>
                Claude{[state.claudeApps.desktop ? ' 桌面版' : '', state.claudeApps.cli ? ` · ${state.claudeApps.cli} 个 Claude Code` : ''].filter(Boolean).join('')}在连接前就开着了:
                它已有的长连接还走着原来的网络,空闲时重开一次才会全部走静态 IP。
              </Banner>
            ) : null}
            <div className="muted" style={{ fontSize: 11.5 }}>
              Claude 今天看到过:{(state.claudeSeen?.today ?? []).join(' / ') || '—'}(核对 {state.claudeSeen?.checks ?? 0} 次)
            </div>
          </div>
        </Card>

        <Card
          title="分流测试"
          hint="按浏览器的路径实际访问一次"
          right={<button className="btn sm" disabled={!connected || splitBusy} onClick={() => void runSplit()}>{splitBusy ? '测试中…' : '开始测试'}</button>}
        >
          {!splits ? (
            <div className="muted" style={{ fontSize: 12 }}>
              AI 应走{hasLine ? '静态 IP' : '节点'};其他国外网站应走{hasSubs ? '节点' : '直连'};国内网站应直连。连上后点「开始测试」。
            </div>
          ) : (
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>线路</th><th>网站</th><th>结果</th><th>实际走</th><th>应该走</th><th>出口</th></tr></thead>
                <tbody>
                  {splits.map((r) => (
                    <tr key={`${r.lane}-${r.name}`}>
                      <td>{laneText(r.lane)}</td>
                      <td>{r.name}</td>
                      <td>{r.ok ? <Pill tone={r.good ? 'ok' : 'warn'}>{r.good ? '正常' : '不对'}</Pill> : <Pill tone="bad">打不开</Pill>}</td>
                      <td>{routeText(r.route)}{r.node && r.route === 'node' ? <span className="muted"> · {r.node}</span> : null}</td>
                      <td className="muted">{expectText(r.expect)}</td>
                      <td className="mono-s">{r.ip ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="网络诊断"
        hint={state.diag ? `${fmtAgo(state.diag.at)}前` : '连不上时先看这里'}
        right={<button className="btn sm" disabled={!connected} onClick={() => void ain.diagnose()}>开始诊断</button>}
      >
        {!state.diag ? <div className="muted" style={{ fontSize: 12 }}>按顺序检查:网络组件 → 你的节点 → 静态 IP → 出口 → AI 网站可达</div> : (
          <div className="grid" style={{ gap: 8 }}>
            <div style={{ fontWeight: 600 }}>{state.diag.summary}</div>
            {state.diag.steps.map((s) => (
              <div key={s.key} className="log-item">
                <span className="kind">{s.title}</span>
                <Pill tone={s.state === 'ok' ? 'ok' : s.state === 'fail' ? 'bad' : s.state === 'warn' ? 'warn' : 'unknown'}>
                  {s.state === 'ok' ? '正常' : s.state === 'fail' ? '失败' : s.state === 'warn' ? '提示' : '跳过'}
                </Pill>
                <span className="txt">{s.detail}</span>
              </div>
            ))}
            {state.diag.advice.length ? (
              <div className="mono-block">{state.diag.advice.map((a) => `· ${a}`).join('\n')}</div>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

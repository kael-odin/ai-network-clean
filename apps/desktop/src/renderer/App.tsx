import { useEffect, useState } from 'react';
import type { AppState } from '../shared/ipc.ts';
import { ain, fmtAgo } from './api.ts';
import { Card, Pill } from './components/ui.tsx';
import { LineForm } from './components/LineForm.tsx';
import { SubsEditor } from './components/SubsEditor.tsx';
import { Home } from './pages/Home.tsx';
import { ClaudePage } from './pages/Claude.tsx';
import { Identities } from './pages/Identities.tsx';
import { Nodes } from './pages/Nodes.tsx';
import { Logs } from './pages/Logs.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

type Page = 'home' | 'claude' | 'identity' | 'nodes' | 'logs' | 'settings';
const PAGES: [Page, string, string][] = [
  ['home', '首页', 'M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z'],
  ['claude', 'Claude', 'M21 12a8 8 0 0 1-8 8H8l-4 3v-5a8 8 0 0 1 8-8h1a8 8 0 0 1 8 2z'],
  ['identity', '身份', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21a8 8 0 0 1 16 0'],
  ['nodes', '节点', 'M5 5h14v5H5z M5 14h14v5H5z M9 7.5h.01 M9 16.5h.01'],
  ['logs', '日志', 'M6 4h9l4 4v12H6z M9 11h6 M9 15h6 M9 19h4'],
  ['settings', '设置', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 6 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13.7H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
];

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>('home');

  useEffect(() => {
    void ain.state().then(setState);
    const off = ain.onState(setState);
    const offNav = ain.onNav((p) => { if (PAGES.some(([k]) => k === p)) setPage(p as Page); });
    return () => { off(); offNav(); };
  }, []);

  if (!state) {
    return (
      <div className="shell">
        <div className="titlebar"><span className="dot" /><span className="name">AI Network Clean</span></div>
        <div className="main"><div className="empty">正在读取状态…</div></div>
      </div>
    );
  }

  const connected = state.conn.status === 'connected';
  const starting = state.conn.status === 'starting';
  const dotCls = connected ? 'on' : starting ? 'busy' : '';

  return (
    <div className="shell">
      <div className="titlebar" style={{ paddingRight: 150 }}>
        <span className={`dot ${dotCls}`} />
        <span className="name">AI Network Clean</span>
        <span className="spacer" />
        <span className="meta">
          {connected ? `已连接 · ${state.conn.exitIp ?? '读取出口中'}` : starting ? '连接中…' : '未连接'}
          {state.admin ? '' : ' · 非管理员'}
        </span>
      </div>
      <div className="body">
        <aside className="sidebar">
          <div className="brand">
            <div className="logo">AI</div>
            <div>
              <div className="t">AI Network Clean</div>
              <div className="s">静态 IP · 只接管 AI 流量</div>
            </div>
          </div>
          {PAGES.map(([key, label, d]) => (
            <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => setPage(key)}>
              <span className="ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
              </span>
              {label}
              {key === 'logs' && state.anomalies.length > 0 ? <span className="badge">{state.anomalies.length}</span> : null}
            </button>
          ))}
          <div className="foot">
            <div>v{state.version}</div>
            <div>{state.settings.line.type === 'none' ? '未填静态 IP' : `${state.settings.line.type.toUpperCase()} · ${state.settings.line.server}`}</div>
            {state.quickAt ? <div>快检 {fmtAgo(state.quickAt)}前</div> : null}
          </div>
        </aside>
        <main className="main">
          {state.step === 'setup' ? <Setup state={state} /> : (
            <>
              {page === 'home' ? <Home state={state} /> : null}
              {page === 'claude' ? <ClaudePage state={state} /> : null}
              {page === 'identity' ? <Identities state={state} /> : null}
              {page === 'nodes' ? <Nodes state={state} /> : null}
              {page === 'logs' ? <Logs state={state} /> : null}
              {page === 'settings' ? <SettingsPage state={state} /> : null}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// 首次打开:填线路 → 连接
function Setup({ state }: { state: AppState }) {
  const line = state.settings.line;
  const hasLine = line.type !== 'none' && !!line.server;
  const hasSubs = state.settings.subs.length > 0;
  return (
    <div className="setup">
      <div>
        <div className="lead">先告诉客户端:AI 的流量从哪出去</div>
        <div className="desc">两条路,可以只填一条,也可以都填:有静态 IP 就让 AI 只走它(最稳),没有就走你的订阅节点。</div>
      </div>
      <Card title="① 我的静态 IP" hint={hasLine ? '已填写' : '可选'}>
        <LineForm settings={state.settings} />
      </Card>
      <Card title="② 节点订阅" hint={hasSubs ? `已添加 ${state.settings.subs.length} 条` : '可选'}>
        <SubsEditor settings={state.settings} />
      </Card>
      <Card title="③ 开始使用">
        <div className="desc" style={{ marginBottom: 10 }}>
          {hasLine || hasSubs ? '线路有了。点下面的按钮立刻连接;以后想让它开机自动连,到「设置 → 行为」打开。' : '两条都是空的:至少填一条才能连接。'}
        </div>
        <div className="btn-row">
          <button className="btn primary" disabled={!hasLine && !hasSubs} onClick={() => void ain.connect()}>连接</button>
          {state.admin ? <Pill tone="ok">管理员权限:可以用虚拟网卡完整接管</Pill> : <Pill tone="warn">不是管理员:只能接管浏览器,想完整接管请右键「以管理员身份运行」</Pill>}
        </div>
      </Card>
    </div>
  );
}

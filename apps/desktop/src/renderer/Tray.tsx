import { useEffect, useState } from 'react';
import type { AppState } from '../shared/ipc.ts';
import { ain, fmtAgo } from './api.ts';
import { Pill } from './components/ui.tsx';

// 托盘面板:360×560,左键点托盘图标弹出
export function Tray() {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void ain.state().then(setState);
    return ain.onState(setState);
  }, []);

  if (!state) return <div className="tray"><div className="empty">读取中…</div></div>;
  const c = state.conn;
  const connected = c.status === 'connected';
  const starting = c.status === 'starting';
  const blocked = state.aiCheck?.state === 'blocked';
  const hasLine = state.settings.line.type !== 'none' && !!state.settings.line.server;

  return (
    <div className="tray">
      <div className="top">
        <span className={`dot`} style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? 'var(--ok)' : starting ? 'var(--warn)' : 'var(--unknown)' }} />
        <span className="name">AI Network Clean</span>
        <span className="right">
          <Pill tone={connected ? 'ok' : starting ? 'warn' : 'unknown'}>{connected ? '已连接' : starting ? '连接中' : '未连接'}</Pill>
        </span>
      </div>

      <div className="card">
        <div className="kv">
          <div className="row"><span className="k">模式</span><span className="v">{c.mode === 'tun' ? '虚拟网卡' : '本地代理'}</span></div>
          <div className="row"><span className="k">出口</span><span className="v mono-s">{c.exitIp ?? '-'}</span></div>
          <div className="row"><span className="k">AI 线路</span><span className="v">{hasLine ? (c.lineUp === false ? '静态 IP 不可用' : '静态 IP') : '你的节点'}</span></div>
          <div className="row"><span className="k">节点</span><span className="v" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.node ?? '-'}</span></div>
          <div className="row"><span className="k">已连接</span><span className="v">{connected ? fmtAgo(c.since) : '-'}</span></div>
        </div>
      </div>

      {blocked ? (
        <div className="banner bad" style={{ fontSize: 12 }}>
          AI 流量已拦截:{state.aiCheck?.reason ?? '防护没有全部通过'}
        </div>
      ) : null}
      {connected && c.lineUp === false ? (
        <div className="banner bad" style={{ fontSize: 12 }}>连不上静态 IP,AI 已暂停{c.downReason ? `:${c.downReason}` : ''}</div>
      ) : null}
      {!connected && c.error ? <div className="banner warn" style={{ fontSize: 12 }}>{c.error.split('\n')[0]}</div> : null}

      <button
        className={`big-btn ${connected ? 'off' : starting ? 'busy' : ''}`}
        onClick={() => void (connected || starting ? ain.disconnect() : ain.connect())}
      >
        {connected ? '断开连接' : starting ? '正在连接…' : '开启连接'}
      </button>

      <div className="foot">
        <button className="btn" style={{ flex: 1 }} onClick={() => { void ain.showWindow(); void ain.hideTray(); }}>打开主窗口</button>
        <button className="btn ghost" onClick={() => void ain.quit()}>退出</button>
      </div>
    </div>
  );
}

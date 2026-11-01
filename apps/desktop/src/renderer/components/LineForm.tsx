import { useEffect, useState } from 'react';
import type { Line, LineTestResult, Settings } from '../../shared/ipc.ts';
import { ain } from '../api.ts';
import { Field, Pill, Switch } from './ui.tsx';

const EMPTY: Line = { type: 'none', server: '', port: 0, username: '', password: '', exitIp: '', viaNode: false };

// 你自己的静态 IP(固定出口)。填了以后 AI 流量走它;不填就走订阅节点
export function LineForm({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<Line>(settings.line);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LineTestResult | null>(null);

  useEffect(() => { setDraft(settings.line); }, [settings.line]);

  const set = <K extends keyof Line>(k: K, v: Line[K]) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(false); setError(null); };

  const save = async () => {
    const l = { ...draft };
    if (l.type !== 'none') {
      if (!l.server.trim()) return setError('地址不能为空');
      if (!Number.isInteger(Number(l.port)) || Number(l.port) < 1 || Number(l.port) > 65535) return setError('端口要填 1–65535 之间的数字');
    }
    l.server = l.server.trim();
    l.port = Number(l.port) || 0;
    l.exitIp = l.exitIp.trim();
    await ain.setSettings({ line: l });
    setSaved(true);
  };

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="row3">
        <Field label="类型" help="静态 IP 服务商给的协议">
          <select className="select" value={draft.type} onChange={(e) => set('type', e.target.value as Line['type'])}>
            <option value="none">不用静态 IP(AI 走订阅节点)</option>
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP</option>
          </select>
        </Field>
        <Field label="地址">
          <input className="input mono" placeholder="203.0.113.10 或 ip.example.com" value={draft.server} disabled={draft.type === 'none'} onChange={(e) => set('server', e.target.value)} />
        </Field>
        <Field label="端口">
          <input className="input mono" placeholder="1080" value={draft.port || ''} disabled={draft.type === 'none'} onChange={(e) => set('port', Number(e.target.value) || 0)} />
        </Field>
      </div>
      <div className="row2">
        <Field label="账号" help="IP 白名单型的代理可以留空">
          <input className="input mono" value={draft.username} disabled={draft.type === 'none'} onChange={(e) => set('username', e.target.value)} />
        </Field>
        <Field label="密码">
          <input className="input mono" type="password" value={draft.password} disabled={draft.type === 'none'} onChange={(e) => set('password', e.target.value)} />
        </Field>
      </div>
      <Field label="期望出口 IP" help="填了才会校验「AI 网站看到的 IP 对不对」">
        <input className="input mono" style={{ maxWidth: 320 }} placeholder="203.0.113.10" value={draft.exitIp} disabled={draft.type === 'none'} onChange={(e) => set('exitIp', e.target.value)} />
      </Field>
      <div className="choice-box">
        <Switch
          title="经节点连接静态 IP"
          desc="直连不通时打开:先经订阅节点,再到静态 IP(需要有一条可用订阅)。机器上已经开着 Clash 之类的 TUN 时不用打开"
          checked={draft.viaNode}
          onChange={(v) => set('viaNode', v)}
        />
      </div>
      <div className="btn-row">
        <button className="btn primary" onClick={save}>保存</button>
        <button
          className="btn"
          disabled={testing || draft.type === 'none' || !draft.server}
          onClick={async () => {
            setTesting(true);
            setTest(null);
            try { setTest(await ain.lineTest({ ...draft, port: Number(draft.port) || 0 })); } finally { setTesting(false); }
          }}
        >
          {testing ? '自检中…' : '自检这条线路'}
        </button>
        {saved ? <span className="pill ok">已保存,断开重连后生效</span> : null}
        {error ? <span className="pill bad">{error}</span> : null}
        {draft.type !== 'none' && !draft.exitIp ? <span className="pill warn">没填期望出口 IP:不做出口比对</span> : null}
      </div>
      {test ? (
        <div className="card" style={{ padding: 12, background: 'var(--panel-2)' }}>
          <div className="tag-line" style={{ marginBottom: 8 }}>
            <Pill tone={test.via === 'node' ? 'brand' : 'unknown'}>{test.via === 'node' ? '经当前节点测试' : '直连测试'}</Pill>
            <span className="muted" style={{ fontSize: 11.5 }}>协议:{test.protocol.toUpperCase()}</span>
          </div>
          <div className="clean-list" style={{ maxHeight: 200 }}>
            {test.steps.map((st) => (
              <div key={st.key} className="log-item" style={{ gridTemplateColumns: '80px 64px 1fr' }}>
                <span className="kind">{st.label}</span>
                <Pill tone={st.ok === true ? 'ok' : st.ok === false ? 'bad' : 'unknown'}>{st.ok === true ? '通过' : st.ok === false ? '失败' : '未定'}</Pill>
                <span className="txt">{st.detail}</span>
              </div>
            ))}
          </div>
          {test.raw ? (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 11.5 }}>供应商原始回复</summary>
              <div className="mono-block" style={{ marginTop: 6, maxHeight: 180, overflow: 'auto' }}>{test.raw}</div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { EMPTY };

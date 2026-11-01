import { useState } from 'react';
import type { Settings, Sub } from '../../shared/ipc.ts';
import { ain } from '../api.ts';
import { Empty, Field } from './ui.tsx';

const randId = () => Math.random().toString(36).slice(2, 8);
const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return '节点订阅'; }
};
const valid = (url: string): boolean => {
  try { const u = new URL(url.trim()); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
};

// 节点订阅:可以放多条,同一时间只用一条
// 订阅链接里带令牌,默认脱敏显示(截图/旁边有人时不会泄露),点一下才展开
const maskUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}/…${x.search ? '?…' : ''}`;
  } catch { return '（格式不对）'; }
};

export function SubsEditor({ settings }: { settings: Settings }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const save = async (subs: Sub[]) => { await ain.setSettings({ subs }); };

  const add = async () => {
    if (!valid(url)) return setError('订阅链接要填 http(s) 地址');
    const sub: Sub = { id: randId(), name: name.trim() || hostOf(url), url: url.trim(), enabled: settings.subs.length === 0 };
    await save([...settings.subs, sub]);
    setName('');
    setUrl('');
    setError(null);
  };

  const use = async (id: string) => save(settings.subs.map((s) => ({ ...s, enabled: s.id === id })));
  const remove = async (id: string) => save(settings.subs.filter((s) => s.id !== id));
  const rename = async (id: string, v: string) => save(settings.subs.map((s) => (s.id === id ? { ...s, name: v.slice(0, 40) } : s)));

  return (
    <div className="grid" style={{ gap: 10 }}>
      {settings.subs.length === 0 ? <Empty>还没有订阅。粘贴节点服务商给的 Clash 订阅链接(通用订阅也支持)</Empty> : null}
      {settings.subs.map((s) => (
        <div key={s.id} className="sub-row">
          <div className="grow">
            <div className="line">
              <input
                className="input"
                style={{ maxWidth: 200 }}
                value={s.name}
                onChange={(e) => void rename(s.id, e.target.value)}
              />
              {s.enabled ? <span className="pill ok"><span className="dot-s" />正在用</span> : <span className="pill unknown">未使用</span>}
            </div>
            <div className="url">
              <span className="mono-s">{reveal[s.id] ? s.url : maskUrl(s.url)}</span>
              <button
                className="btn sm ghost"
                style={{ padding: '0 4px' }}
                onClick={() => setReveal((r) => ({ ...r, [s.id]: !r[s.id] }))}
              >
                {reveal[s.id] ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
          <div className="btn-row">
            {!s.enabled ? <button className="btn sm" onClick={() => void use(s.id)}>使用这条</button> : null}
            <button className="btn sm danger" onClick={() => void remove(s.id)}>删除</button>
          </div>
        </div>
      ))}
      <div className="row2" style={{ alignItems: 'end' }}>
        <Field label="名称(可不填)">
          <input className="input" placeholder="比如:机场 A" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="订阅链接" help="从节点服务商复制,通常以 http(s):// 开头">
          <input className="input mono" placeholder="https://…/subscribe?token=…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
      </div>
      <div className="btn-row">
        <button className="btn primary" onClick={add}>添加订阅</button>
        {error ? <span className="pill bad">{error}</span> : null}
      </div>
    </div>
  );
}

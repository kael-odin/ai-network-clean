import { useMemo, useState } from 'react';
import type { AiRoute, AppState, RuleRoute, UserRule } from '../../shared/ipc.ts';
import { ain } from '../api.ts';
import { Card, Empty, Field, Pill } from '../components/ui.tsx';
import { SubsEditor } from '../components/SubsEditor.tsx';

const REGIONS: [string, string][] = [['', '全部'], ['HK', '香港'], ['TW', '台湾'], ['JP', '日本'], ['SG', '新加坡'], ['US', '美国'], ['KR', '韩国'], ['OTHER', '其他']];
const ROUTE_TEXT: Record<RuleRoute, string> = { static: '静态 IP', node: '你的节点', direct: '直连' };

export function Nodes({ state }: { state: AppState }) {
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('');
  const [sort, setSort] = useState<'default' | 'delay' | 'name'>('default');
  const [busy, setBusy] = useState<'test' | 'refresh' | null>(null);
  const [ruleDomain, setRuleDomain] = useState('');
  const [ruleRoute, setRuleRoute] = useState<RuleRoute>('node');

  const nodes = state.nodes?.nodes ?? [];
  const favs = state.settings.favNodes ?? [];
  const shown = useMemo(() => {
    const base = nodes.filter((n) => (!region || n.region === region) && (!search || n.name.toLowerCase().includes(search.toLowerCase())));
    const byDelay = (a: typeof base[number], b: typeof base[number]) => (a.delay ?? 1e9) - (b.delay ?? 1e9);
    const sorted = [...base];
    if (sort === 'delay') sorted.sort(byDelay);
    else if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    // 收藏的永远排最前
    return [...sorted.filter((n) => favs.includes(n.name)), ...sorted.filter((n) => !favs.includes(n.name))];
  }, [nodes, region, search, sort, favs]);

  const toggleFav = async (name: string) => {
    const next = favs.includes(name) ? favs.filter((x) => x !== name) : [...favs, name].slice(0, 20);
    await ain.setSettings({ favNodes: next });
  };
  const connected = state.conn.status === 'connected';

  const doTest = async () => { setBusy('test'); try { await ain.testNodes(); } finally { setBusy(null); } };
  const doRefresh = async () => { setBusy('refresh'); try { await ain.refreshNodes(); } finally { setBusy(null); } };

  const setRoute = async (k: keyof AppState['settings']['aiRoutes'], v: AiRoute) => {
    await ain.setSettings({ aiRoutes: { ...state.settings.aiRoutes, [k]: v } });
  };
  const addRule = async () => {
    const domain = ruleDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    if (!/^(?=.{3,120}$)([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(domain)) return;
    if (state.settings.rules.some((r) => r.domain === domain)) return;
    await ain.setSettings({ rules: [...state.settings.rules, { domain, route: ruleRoute }] });
    setRuleDomain('');
  };
  const delRule = async (d: string) => ain.setSettings({ rules: state.settings.rules.filter((r) => r.domain !== d) });

  return (
    <div className="grid" style={{ gap: 12 }}>
      <Card title="节点订阅" hint="可以放多条,同一时间只用一条;换订阅会自动重连">
        <SubsEditor settings={state.settings} />
      </Card>

      <Card
        title="节点"
        hint={state.nodes ? `${nodes.length} 个${state.nodes.updatedAt ? ` · 更新于 ${new Date(state.nodes.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}` : '连上后读取'}
        right={(
          <div className="btn-row">
            <button className="btn sm" disabled={!connected || busy !== null} onClick={() => void doTest()}>{busy === 'test' ? '测速中…' : '测速'}</button>
            <button className="btn sm" disabled={!connected || busy !== null} onClick={() => void doRefresh()}>{busy === 'refresh' ? '刷新中…' : '重拉订阅'}</button>
          </div>
        )}
      >
        <div className="tag-line" style={{ marginBottom: 10 }}>
          <input className="input" style={{ maxWidth: 220 }} placeholder="搜索节点" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select" style={{ width: 130 }} value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
          <select className="select" style={{ width: 130 }} value={sort} onChange={(e) => setSort(e.target.value as 'default' | 'delay' | 'name')}>
            <option value="default">默认顺序</option>
            <option value="delay">按延迟</option>
            <option value="name">按名称</option>
          </select>
          {favs.length ? <button className="btn sm ghost" onClick={() => void ain.setSettings({ favNodes: [] })}>清空收藏({favs.length})</button> : null}
          <button className="btn sm" disabled={!connected} onClick={() => void ain.setSettings({ ownNode: '' })}>恢复自动选择</button>
        </div>
        {!connected ? <Empty>连接后才会读节点(内核要对订阅做测速)</Empty> : shown.length === 0 ? <Empty>没有符合条件的节点</Empty> : (
          <div className="scroll-x" style={{ maxHeight: 'calc(100vh - 420px)', overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>节点</th><th>类型</th><th>延迟</th><th>地区</th><th>状态</th><th /></tr></thead>
              <tbody>
                {shown.map((n) => {
                  const sel = state.nodes?.selected === n.name;
                  return (
                    <tr key={`${n.provider}-${n.name}`} className="click" onClick={() => void ain.selectNode(n.name)}>
                      <td style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n.name}>
                        <button
                          className="btn sm ghost"
                          style={{ padding: '0 4px', color: favs.includes(n.name) ? '#d97706' : 'var(--text-3)' }}
                          title={favs.includes(n.name) ? '取消收藏' : '收藏(置顶)'}
                          onClick={(e) => { e.stopPropagation(); void toggleFav(n.name); }}
                        >{favs.includes(n.name) ? '★' : '☆'}</button>
                        {n.name}
                      </td>
                      <td className="muted">{n.type}</td>
                      <td className="mono-s">{n.delay === null ? '-' : `${n.delay} ms`}</td>
                      <td className="muted">{REGIONS.find(([k]) => k === n.region)?.[1] ?? n.region}</td>
                      <td>{n.alive ? <Pill tone="ok">可用</Pill> : <Pill tone="unknown">未测通</Pill>}</td>
                      <td className="right">{sel ? <Pill tone="brand">正在用</Pill> : <span className="muted">选择</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          点一行切换节点;内核的「自动选择」会按延迟挑最快的,固定某个节点后一直用它。
        </div>
      </Card>

      <Card title="分流设置" hint="AI 服务走静态 IP 还是你的节点;自己的网站规则">
        <div className="grid c4" style={{ marginBottom: 12 }}>
          {([['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['meta', 'Meta AI']] as const).map(([k, label]) => (
            <Field key={k} label={label}>
              <select className="select" value={state.settings.aiRoutes[k]} onChange={(e) => void setRoute(k, e.target.value as AiRoute)}>
                <option value="static">静态 IP</option>
                <option value="node">你的节点</option>
              </select>
            </Field>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
          Claude 固定走静态 IP(关系到不封号的出口一致性,不开放修改)。ChatGPT / Gemini 官方默认走静态 IP。
        </div>
        <div className="sep" />
        <div className="row3" style={{ alignItems: 'end' }}>
          <Field label="自己的规则:域名">
            <input className="input mono" placeholder="example.com" value={ruleDomain} onChange={(e) => setRuleDomain(e.target.value)} />
          </Field>
          <Field label="走哪条线">
            <select className="select" value={ruleRoute} onChange={(e) => setRuleRoute(e.target.value as RuleRoute)}>
              <option value="static">静态 IP</option>
              <option value="node">你的节点</option>
              <option value="direct">直连</option>
            </select>
          </Field>
          <div><button className="btn primary" onClick={() => void addRule()}>添加规则</button></div>
        </div>
        <div style={{ marginTop: 10 }}>
          {state.settings.rules.length === 0 ? <Empty>还没有自定义规则</Empty> : (
            <div className="tag-line">
              {state.settings.rules.map((r: UserRule) => (
                <span key={r.domain} className="chip">
                  <span className="mono-s">{r.domain}</span>
                  <span className="muted">→ {ROUTE_TEXT[r.route]}</span>
                  <button className="btn sm ghost" style={{ padding: '0 4px' }} onClick={() => void delRule(r.domain)}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
          规则放在所有 AI 规则之后(带不偏 Claude)、默认规则之前;claude.ai / anthropic.com 等固定走静态 IP,不受这里影响。
        </div>
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { AppState, IdentityState } from '../../shared/ipc.ts';
import { ain, fmtAgo, fmtBytes, fmtTime } from '../api.ts';
import { Banner, Card, Empty, Icon, Pill } from '../components/ui.tsx';

const ICON = {
  id: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21a8 8 0 0 1 16 0',
  box: 'M4 7l8-4 8 4v10l-8 4-8-4z M4 7l8 4 8-4 M12 11v10',
};

export function Identities({ state }: { state: AppState }) {
  const [ids, setIds] = useState<IdentityState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const reload = async (deep = false) => setIds(await ain.identities(deep));
  useEffect(() => {
    // 先拿快照(秒开),再补一次真实位置的完整统计
    void (async () => {
      const fast = await ain.identities(false);
      setIds(fast);
      if (!fast.live.measured) setIds(await ain.identities(true));
    })();
  }, []);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try { await fn(); await reload(true); }
    catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(null); }
  };

  const active = ids?.identities.find((x) => x.active) ?? null;
  const running = ids?.claudeRunning;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <Card title="身份隔离" hint="每个身份一套独立的 Claude 本地数据">
        <div className="grid c3" style={{ marginBottom: 12 }}>
          <div className="stat">
            <div className="k">当前身份</div>
            <div className="v">{active ? active.name : '未归档(直接使用中的那一套)'}</div>
            <div className="d">{active ? `上次使用 ${fmtTime(active.lastUsedAt)}` : '点下面的「归档」把现在这套存成一个身份'}</div>
          </div>
          <div className="stat">
            <div className="k">真实位置的数据</div>
            <div className="v">{ids ? (ids.live.measured ? `${fmtBytes(ids.live.bytes)} · ${ids.live.files} 个文件` : '统计中…') : '-'}</div>
            <div className="d">
              {ids ? [ids.live.claude ? 'Claude Code' : '', ids.live.claudeJson ? '.claude.json' : '', ids.live.appdata ? '桌面版' : ''].filter(Boolean).join(' / ') || '没有数据' : ''}
            </div>
          </div>
          <div className="stat">
            <div className="k">Claude 进程</div>
            <div className="v">
              {running && (running.desktop || running.cli > 0)
                ? <Pill tone="warn">{running.desktop ? '桌面版在跑' : ''}{running.desktop && running.cli ? ' · ' : ''}{running.cli ? `${running.cli} 个命令行` : ''}</Pill>
                : <Pill tone="ok">没有在跑</Pill>}
            </div>
            <div className="d">切换或归档前要先结束它,否则文件被占用、数据会混在一起</div>
          </div>
        </div>

        <Banner tone="info">
          做法是**同盘目录改名**:不压缩、不加密、不复制、不删除。
          切换 = 把现在这套搬回它所属的身份、再把你选的那套搬到真实位置;中途出错会按逆序搬回去。
        </Banner>
      </Card>

      <Card
        title="身份"
        hint={ids ? `${ids.identities.length} 个` : '读取中'}
        right={<button className="btn sm" onClick={() => void reload(true)}>重新统计</button>}
      >
        {error ? (
          <div style={{ marginBottom: 10 }}>
            <Banner tone="bad" right={
              (running && (running.desktop || running.cli > 0)) ? (
                <button className="btn sm" disabled={busy !== null} onClick={() => void act('kill', () => ain.identityKillClaude())}>结束 Claude 并重试</button>
              ) : undefined
            }>{error}</Banner>
          </div>
        ) : null}
        {!ids ? <Empty>读取中…</Empty> : ids.identities.length === 0 ? (
          <Empty>还没有身份。把当前这套 Claude 数据归档,就会成为第一个身份</Empty>
        ) : (
          <div className="clean-list" style={{ maxHeight: 'none' }}>
            {ids.identities.map((it) => (
              <div key={it.id} className="clean-row" style={{ gridTemplateColumns: '18px minmax(160px, 1.2fr) auto minmax(120px, 1fr) auto' }}>
                <span style={{ color: it.active ? 'var(--brand)' : 'var(--text-3)', display: 'grid', placeItems: 'center' }}>
                  <Icon d={it.active ? ICON.id : ICON.box} size={16} />
                </span>
                <span className="name">
                  {it.name}
                  {it.active ? <span style={{ marginLeft: 8 }}><Pill tone="brand">当前</Pill></span> : null}
                  {it.account ? <span className="muted" style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 11 }}>账号 {it.account}</span> : null}
                </span>
                <span className="muted" style={{ fontSize: 11.5 }}>{fmtBytes(it.bytes)} · {it.files} 文件</span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {it.projects ? `${it.projects} 个项目` : '没有会话'}
                  {it.lastActiveAt ? ` · 最后活跃 ${fmtAgo(it.lastActiveAt)}前` : ''}
                </span>
                <span className="btn-row" style={{ justifyContent: 'flex-end' }}>
                  {!it.active ? (
                    <button className="btn sm" disabled={busy !== null} onClick={() => void act(`a-${it.id}`, () => ain.identityActivate(it.id))}>
                      {busy === `a-${it.id}` ? '切换中…' : '切换'}
                    </button>
                  ) : null}
                  <button
                    className="btn sm ghost"
                    disabled={busy !== null}
                    onClick={() => { const v = prompt('改个名字', it.name); if (v) void act(`r-${it.id}`, () => ain.identityRename(it.id, v)); }}
                  >重命名</button>
                  {!it.active ? (
                    confirmRemove === it.id ? (
                      <>
                        <button className="btn sm danger" disabled={busy !== null} onClick={() => void act(`d-${it.id}`, () => ain.identityRemove(it.id))}>确认删除</button>
                        <button className="btn sm ghost" onClick={() => setConfirmRemove(null)}>取消</button>
                      </>
                    ) : (
                      <button className="btn sm danger" disabled={busy !== null} onClick={() => setConfirmRemove(it.id)}>删除</button>
                    )
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="clean-foot">
          <input className="input" style={{ maxWidth: 240 }} placeholder="给当前这套数据起个名字" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn primary"
            disabled={busy !== null || !name.trim()}
            onClick={() => void act('capture', async () => { await ain.identityCapture(name.trim()); setName(''); })}
          >
            {busy === 'capture' ? '归档中…' : '归档为新身份'}
          </button>
          <span className="muted" style={{ fontSize: 11.5 }}>会把现在的 Claude Code 登录/会话/插件与桌面版数据一起搬进新身份</span>
        </div>
      </Card>

      <Card title="切换前要做什么">
        <div className="mono-block">{`1. 结束 Claude 桌面版和所有 Claude Code 终端（按钮会自动做）
2. 切换是秒级的（同盘改名），不会复制、不会压缩
3. 切换后重新打开 Claude：登录态、会话、插件、MCP 都是那套身份的
4. skills / 插件 / MCP 想跨身份共享的话，把条目放在各自身份里即可（本工具不主动合并）`}</div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          身份槽位置：数据目录下的 identities\&lt;id&gt;\（home-claude / home-claude.json / appdata-claude）
          {state.packaged ? '' : ' · 当前是开发版'}
        </div>
      </Card>
    </div>
  );
}

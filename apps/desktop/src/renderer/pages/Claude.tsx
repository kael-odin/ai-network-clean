import { useEffect, useMemo, useState } from 'react';
import type { AppState, CleanResult, LaunchKind } from '../../shared/ipc.ts';
import { ain, fmtBytes, fmtTime } from '../api.ts';
import { Banner, Card, Empty, Icon, Pill } from '../components/ui.tsx';

const ICONS = {
  code: 'M4 6h16v12H4z M8 10l2 2-2 2 M12 14h4',
  desktop: 'M4 5h16v11H4z M9 20h6 M12 16v4',
  web: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3.6 3 14.4 0 18 M12 3c-3 3.6-3 14.4 0 18',
} as const;

const GROUP_TEXT = { session: '会话', cache: '缓存', auth: '登录' } as const;
const GROUP_TONE = { session: 'warn', cache: 'unknown', auth: 'bad' } as const;

export function ClaudePage({ state }: { state: AppState }) {
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [result, setResult] = useState<CleanResult | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);

  const connected = state.conn.status === 'connected';
  const run = state.claudeRun;
  const env = state.env;

  // 页面打开时主动刷新一次「哪些 Claude 在跑」
  useEffect(() => {
    void ain.claudeStatus();
    const t = setInterval(() => void ain.claudeStatus(), 15_000);
    return () => clearInterval(t);
  }, []);

  const scan = async () => {
    setBusy('scan');
    try { await ain.claudeScan(); setToast('已扫描'); } finally { setBusy(null); }
  };

  const toggle = (id: string, on: boolean) => setPicked((p) => ({ ...p, [id]: on }));
  const pickRecommended = () => {
    const next: Record<string, boolean> = {};
    for (const t of state.clean?.targets ?? []) if (t.exists && t.group !== 'auth' && t.bytes > 0) next[t.id] = true;
    setPicked(next);
  };
  const pickedIds = useMemo(() => Object.entries(picked).filter(([, v]) => v).map(([k]) => k), [picked]);
  const pickedBytes = useMemo(
    () => (state.clean?.targets ?? []).filter((t) => picked[t.id]).reduce((n, t) => n + t.bytes, 0),
    [state.clean, picked],
  );

  const doClean = async () => {
    setBusy('clean');
    try {
      const r = await ain.claudeClean(pickedIds, backup);
      setResult(r);
      setPicked({});
      setConfirmClean(false);
      setToast(r.errors.length ? `完成,${r.errors.length} 项失败` : '清理完成');
    } finally { setBusy(null); }
  };

  const launch = async (kind: LaunchKind) => {
    setBusy(kind);
    try {
      const r = await ain.claudeLaunch(kind);
      setToast(r.detail);
    } finally { setBusy(null); }
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <Card title="Claude 现在的情况" hint="连上以后每轮检测都会更新">
        <div className="grid c3">
          <div className="stat">
            <div className="k">官方状态</div>
            <div className="v">
              {state.claudeStatus ? (
                <Pill tone={state.claudeStatus.level === 'ok' ? 'ok' : state.claudeStatus.level === 'maintenance' ? 'warn' : 'bad'}>
                  {state.claudeStatus.level === 'ok' ? '正常' : state.claudeStatus.level === 'maintenance' ? '维护中' : state.claudeStatus.level === 'minor' ? '部分故障' : '故障'}
                </Pill>
              ) : <Pill tone="unknown">未读取</Pill>}
            </div>
            <div className="d">{state.claudeStatus?.text || '连上后读取 status.claude.com'}</div>
          </div>
          <div className="stat">
            <div className="k">看到的出口</div>
            <div className="v mono-s">
              {state.aiCheck?.sites?.find((s) => s.name === 'Claude')?.ip ?? state.conn.exitIp ?? '-'}
            </div>
            <div className="d">{state.settings.line.exitIp ? `期望 ${state.settings.line.exitIp}` : '静态 IP 里没填期望出口'}</div>
          </div>
          <div className="stat">
            <div className="k">Claude Code 代理</div>
            <div className="v">
              {state.claudeCode ? (
                <Pill tone={state.claudeCode.state === 'ok' ? 'ok' : 'warn'}>{state.claudeCode.state === 'ok' ? '走客户端' : '需要修正'}</Pill>
              ) : <Pill tone="unknown">未检测</Pill>}
            </div>
            <div className="d">{state.claudeCode?.detail ?? '连上后检测'}</div>
          </div>
        </div>
        {state.claudeCode?.fixable ? (
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => void ain.ccFix()}>一键把 Claude Code 指到客户端</button>
          </div>
        ) : null}
      </Card>

      <Card title="从这里启动 Claude" hint="子进程直接继承代理环境,不依赖系统代理">
        {!connected ? (
          <Banner tone="info">先回「首页」连接,再从这里启动,子进程才会走静态 IP</Banner>
        ) : null}
        <div className="grid c3" style={{ marginTop: connected ? 0 : 10 }}>
          <div className="launch-card">
            <div className="ico"><Icon d={ICONS.code} /></div>
            <div className="t">Claude Code</div>
            <div className="d">新开一个终端,环境里带好 HTTP(S)_PROXY,直接跑 claude</div>
            <button className="btn primary" disabled={!connected || busy !== null} onClick={() => void launch('code')}>
              {busy === 'code' ? '启动中…' : '打开终端'}
            </button>
          </div>
          <div className="launch-card">
            <div className="ico"><Icon d={ICONS.desktop} /></div>
            <div className="t">Claude 桌面版</div>
            <div className="d">非商店版会带上代理环境;商店版只能用 TUN 才能全链路</div>
            <button className="btn primary" disabled={!connected || busy !== null} onClick={() => void launch('desktop')}>
              {busy === 'desktop' ? '启动中…' : '启动桌面版'}
            </button>
          </div>
          <div className="launch-card">
            <div className="ico"><Icon d={ICONS.web} /></div>
            <div className="t">Claude 网页版</div>
            <div className="d">推荐用你自己的浏览器（Chrome / Adspower）：指纹真实，Cloudflare 一次就过；流量走系统代理 → 内核</div>
            <div className="btn-row">
              <button
                className="btn primary"
                disabled={!connected}
                title="用你的默认浏览器打开，流量仍然走系统代理 → 内核"
                onClick={() => { void ain.openUrl('https://claude.ai/new'); setToast('已在默认浏览器打开 claude.ai（流量走系统代理 → 内核）'); }}
              >用默认浏览器</button>
              <button className="btn" disabled={!connected || busy !== null} title="内置窗口不依赖系统代理，但 Cloudflare 常挑战 Electron，可能反复验证" onClick={() => void launch('web')}>
                {busy === 'web' ? '打开中…' : '内置窗口'}
              </button>
            </div>
          </div>
        </div>
        {run && (run.desktop || run.cli) ? (
          <div style={{ marginTop: 10 }}>
            <Banner tone={state.conn.mode === 'proxy' && run.desktop ? 'warn' : 'info'}>
              现在有 {run.desktop ? 'Claude 桌面版' : ''}{run.desktop && run.cli ? ' + ' : ''}{run.cli ? `${run.cli} 个 Claude Code` : ''} 在运行。
              {state.conn.mode === 'proxy' && run.desktop
                ? '本地代理模式下桌面版的子进程可能绕过代理直连——建议退出它,从上面重新启动,或改用 TUN 模式。'
                : '它们是在连接前启动的话,长连接还走着原来的网络,空闲时重开一次更稳。'}
            </Banner>
          </div>
        ) : null}
        {toast ? <div className="hint-line" style={{ marginTop: 10 }}>{toast}</div> : null}
      </Card>

      <Card
        title="环境一致性"
        hint="出口国家 / 时区 / 语言对不上,是最容易被关联的特征"
        right={<button className="btn sm" onClick={() => void ain.envRecheck()}>重新检测</button>}
      >
        {!env ? <Empty>连上后自动核验。出口国家来自 cloudflare 的 trace,时区/语言读本机设置</Empty> : (
          <>
            <div className="tag-line" style={{ marginBottom: 10 }}>
              <Pill tone={env.country ? 'brand' : 'unknown'}>出口国家 {env.country ?? '未知'}</Pill>
              <Pill tone={env.ok ? 'ok' : env.items.some((i) => i.ok === false) ? 'bad' : 'unknown'}>
                {env.ok ? '一致' : env.items.some((i) => i.ok === false) ? '有矛盾' : '无法判断'}
              </Pill>
              <span className="muted" style={{ fontSize: 11.5 }}>检测于 {fmtTime(env.at)}</span>
            </div>
            <table className="table">
              <thead><tr><th style={{ width: 96 }}>项</th><th style={{ width: 150 }}>应该</th><th>实际</th><th style={{ width: 80 }}>结论</th></tr></thead>
              <tbody>
                {env.items.map((i) => (
                  <tr key={i.key}>
                    <td>{i.label}</td>
                    <td className="muted">{i.expected}</td>
                    <td>
                      <span className={i.key === 'tz' ? 'mono-s' : ''}>{i.actual}</span>
                      {i.hint ? <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{i.hint}</div> : null}
                    </td>
                    <td>
                      {i.ok === null ? <Pill tone="unknown">参考</Pill> : i.ok ? <Pill tone="ok">一致</Pill> : <Pill tone="bad">不一致</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {env.items.some((i) => i.ok === false) ? (
              <div style={{ marginTop: 10 }}>
                <Banner tone="warn">
                  时区/语言和出口国家不一致。要更像"当地人":把 Windows 时区改成出口国家、系统语言加到对应语言;或者在别的浏览器/系统账户里专门跑 Claude。
                </Banner>
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Card
        title="本地残留清理"
        hint="换账号或重装前清一遍,减少同机关联"
        right={(
          <div className="btn-row">
            <button className="btn sm" disabled={busy !== null} onClick={() => void scan()}>{busy === 'scan' ? '扫描中…' : '扫描'}</button>
            <button className="btn sm ghost" disabled={busy !== null || !state.clean} onClick={pickRecommended}>选中会话+缓存</button>
          </div>
        )}
      >
        {!state.clean ? <Empty>点「扫描」看哪些文件和会话留在本机(只扫 Claude 自己的目录)</Empty> : (
          <>
            <div className="clean-list">
              {state.clean.targets.map((t) => (
                <label key={t.id} className={`clean-row ${t.exists && t.bytes > 0 ? '' : 'off'}`}>
                  <input
                    type="checkbox"
                    disabled={!t.exists || busy !== null}
                    checked={!!picked[t.id]}
                    onChange={(e) => toggle(t.id, e.target.checked)}
                  />
                  <span className="name">{t.label}</span>
                  <Pill tone={GROUP_TONE[t.group]}>{GROUP_TEXT[t.group]}</Pill>
                  <span className="note muted">{t.note}</span>
                  <span className="size mono-s">{t.exists ? (t.bytes ? fmtBytes(t.bytes) : '空') : '不存在'}</span>
                </label>
              ))}
            </div>
            <div className="clean-foot">
              <span className="muted" style={{ fontSize: 12 }}>
                合计 {fmtBytes(state.clean.totalBytes)};已选 {pickedIds.length} 项 / {fmtBytes(pickedBytes)}
              </span>
              <label className="inline-check">
                <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
                先备份(删错了能捞回来)
              </label>
              <span style={{ flex: 1 }} />
              {!confirmClean ? (
                <button className="btn danger" disabled={!pickedIds.length || busy !== null} onClick={() => setConfirmClean(true)}>
                  清理选中项
                </button>
              ) : (
                <>
                  <button className="btn danger" disabled={busy !== null} onClick={() => void doClean()}>{busy === 'clean' ? '清理中…' : '确认清理(会先断开连接)'}</button>
                  <button className="btn ghost" onClick={() => setConfirmClean(false)}>取消</button>
                </>
              )}
            </div>
            {result ? (
              <div className="hint-line" style={{ marginTop: 10 }}>
                删除了 {result.removed.length} 项({fmtBytes(result.bytes)})
                {result.backupDir ? `,备份在 ${result.backupDir}` : ',未备份'}
                {result.errors.length ? `;${result.errors.length} 项失败:${result.errors[0]}` : ''}
              </div>
            ) : null}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              「登录」组删掉会退出 Claude Code,下次要重新登录;会话和缓存不会影响登录。
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { AppState, Settings, TunMode } from '../../shared/ipc.ts';
import { ain } from '../api.ts';
import { Card, Field, Pill, Switch } from '../components/ui.tsx';
import { LineForm } from '../components/LineForm.tsx';

// settings-2026-11-01T11-19-19.json → 2026-11-01 11:19:19
const fmtBackup = (b: string) => {
  const m = b.match(/^settings-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.json$/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : b;
};

const HOME_REGIONS: [string, string][] = [['CN', '中国大陆'], ['HK', '香港'], ['TW', '台湾'], ['JP', '日本'], ['SG', '新加坡'], ['US', '美国'], ['KR', '韩国'], ['GB', '英国'], ['DE', '德国'], ['NL', '荷兰']];

export function SettingsPage({ state }: { state: AppState }) {
  const s = state.settings;
  const [mixed, setMixed] = useState(String(s.mixedPort));
  const [ctrl, setCtrl] = useState(String(s.controllerPort));
  const [savedPorts, setSavedPorts] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [backups, setBackups] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { setMixed(String(s.mixedPort)); setCtrl(String(s.controllerPort)); }, [s.mixedPort, s.controllerPort]);
  useEffect(() => { void ain.settingsBackups().then(setBackups); }, []);

  const patch = async (p: Partial<Settings>) => { await ain.setSettings(p); };
  const savePorts = async () => {
    const m = Number(mixed);
    const c = Number(ctrl);
    if (!Number.isInteger(m) || m < 1024 || m > 65535) return;
    if (!Number.isInteger(c) || c < 1024 || c > 65535 || c === m) return;
    await patch({ mixedPort: m, controllerPort: c });
    setSavedPorts(true);
  };

  return (
    <div className="grid" style={{ gap: 12 }}>
      <Card title="我的静态 IP" hint="AI 流量只走它;不填就走订阅节点">
        <LineForm settings={s} />
      </Card>

      <Card title="连接" hint="改端口或接管方式后断开重连才生效">
        <div className="row3">
          <Field label="接管方式" help={state.admin ? '有管理员权限,可以用虚拟网卡接管全部程序' : '当前不是管理员:只能用本地代理模式接管浏览器'}>
            <select className="select" value={s.tun} onChange={(e) => void patch({ tun: e.target.value as TunMode })}>
              <option value="auto">自动(推荐)</option>
              <option value="on">强制虚拟网卡</option>
              <option value="off">只用本地代理</option>
            </select>
          </Field>
          <Field label="本地代理端口">
            <input className="input mono" value={mixed} onChange={(e) => { setMixed(e.target.value); setSavedPorts(false); }} />
          </Field>
          <Field label="控制端口" help="内核的本地接口,只监听 127.0.0.1">
            <input className="input mono" value={ctrl} onChange={(e) => { setCtrl(e.target.value); setSavedPorts(false); }} />
          </Field>
        </div>
        <div className="btn-row" style={{ marginTop: 10, alignItems: 'center' }}>
          <button className="btn primary" onClick={() => void savePorts()}>保存端口</button>
          {savedPorts ? <span className="pill ok">已保存</span> : null}
          <span className="muted" style={{ fontSize: 11.5 }}>Clash 常用的 7897 / 7890 空闲时会被一起接管,记着旧端口的程序不用重启</span>
        </div>
        <div className="sep" />
        <Field label="本地直连的地区" help="国内网站直连按这个国家/地区判断(GEOIP);国内用户保持「中国大陆」">
          <select className="select" style={{ maxWidth: 220 }} value={s.homeRegion} onChange={(e) => void patch({ homeRegion: e.target.value })}>
            {HOME_REGIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </Field>
      </Card>

      <Card title="行为">
        <Switch title="开机启动" desc="登录 Windows 后自动启动,窗口不弹出(需要管理员时用计划任务,不会弹授权)" checked={s.autoStart} onChange={(v) => void patch({ autoStart: v })} />
        <Switch title="启动后自动连接" desc="开机自启时会先等网络就绪再连(最多等 5 分钟)" checked={s.autoConnect} onChange={(v) => void patch({ autoConnect: v })} />
        <Switch title="关闭窗口后留在托盘" desc="关掉就是退出后台;开着则点关闭只是收进右下角" checked={s.keepBackground} onChange={(v) => void patch({ keepBackground: v })} />
        <Switch
          title="内置 Claude 窗口跟随出口地区"
          desc="打开「Claude」页的网页窗口时，把时区/语言调到出口 IP 所在国家（IP 与本地时区矛盾是最常见的关联特征）"
          checked={s.webFollowRegion}
          onChange={(v) => void patch({ webFollowRegion: v })}
        />
        <Switch
          title="内置 Claude 窗口加指纹噪声"
          desc={`Canvas / WebGL 读数带由种子决定的微小扰动（同一台"设备"每次一致，换种子等于换机器）。当前种子：${s.fpSeed || '未生成（打开窗口时自动生成）'}`}
          checked={s.fpNoise}
          onChange={(v) => void patch({ fpNoise: v })}
        />
        <div className="btn-row" style={{ padding: '0 0 10px' }}>
          <button className="btn sm" onClick={() => void ain.fpReset()}>重置指纹种子</button>
          <span className="muted" style={{ fontSize: 11.5 }}>换了种子，内置窗口在网站眼里就是另一台设备；已登录的会话不受影响</span>
        </div>
        <Switch
          title="自动修正 Claude Code 的代理"
          desc="连上时把 ~/.claude/settings.json 的 HTTPS_PROXY 指到本客户端,断开/退出时还原(改前会备份)"
          checked={s.claudeCodeFix}
          onChange={(v) => void patch({ claudeCodeFix: v })}
        />
      </Card>

      <Card title="维护">
        <div className="btn-row">
          <button className="btn" disabled={busy !== null} onClick={async () => { setBusy('diag'); try { await ain.copyDiag(); } finally { setBusy(null); } }}>复制诊断报告</button>
          <button className="btn" onClick={() => void ain.openDataDir()}>打开数据目录</button>
          {!state.admin ? (
            <button
              className="btn"
              onClick={async () => {
                const r = await ain.relaunchAsAdmin();
                setBusy('admin');
                window.setTimeout(() => setBusy(null), 4000);
                if (!r.ok) window.alert('没能请求管理员权限：' + r.detail);
              }}
            >
              {busy === 'admin' ? '正在重启…' : '以管理员身份重启（开 TUN）'}
            </button>
          ) : null}
          {!confirmReset ? (
            <button className="btn danger" onClick={() => setConfirmReset(true)}>重置全部设置</button>
          ) : (
            <>
              <button className="btn danger" onClick={async () => { await ain.resetSettings(); setConfirmReset(false); }}>确认重置(会断开连接)</button>
              <button className="btn ghost" onClick={() => setConfirmReset(false)}>取消</button>
            </>
          )}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>重置会清空静态 IP、订阅、规则和所有开关;日志文件保留在数据目录里</div>
        <div className="sep" />
        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
            设置备份（{backups.length} 份，每次保存自动留一份，保留最近 5 份）
          </summary>
          <div style={{ marginTop: 8 }}>
            {backups.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>还没有备份：改一次设置就会生成</div> : (
              <div className="clean-list" style={{ maxHeight: 200 }}>
                {backups.map((b) => (
                  <div key={b} className="clean-row" style={{ gridTemplateColumns: '1fr auto' }}>
                    <span className="mono-s">{fmtBackup(b)}</span>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        await ain.settingsRestore(b);
                        setBackups(await ain.settingsBackups());
                      }}
                    >恢复到这一份</button>
                  </div>
                ))}
              </div>
            )}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>恢复前会先把当前设置再存一份，所以恢复本身也能反悔</div>
          </div>
        </details>
      </Card>

      <Card title="关于">
        <div className="tag-line">
          <Pill tone="brand">v{state.version}</Pill>
          {state.packaged ? <Pill tone="unknown">安装版</Pill> : <Pill tone="unknown">开发版</Pill>}
          {state.admin ? <Pill tone="ok">管理员</Pill> : <Pill tone="warn">非管理员</Pill>}
          {state.tunAvailable ? <Pill tone="ok">可用虚拟网卡</Pill> : <Pill tone="warn">只能用本地代理</Pill>}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
          · 没有账号、没有注册、没有计费:线路就是你自己填的静态 IP 和你自己的订阅<br />
          · 没有遥测:连接日志、异常记录只写在本机;唯一的外部请求是内核拉你自己的订阅、读 Claude 官方状态、以及出口核对<br />
          · 没有自动更新:程序不会自己下载或替换任何文件
        </div>
      </Card>
    </div>
  );
}

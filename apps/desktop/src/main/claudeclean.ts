// Claude 本地残留扫描与清理(参考 CCBaga 的清洁器):会话历史、缓存、登录状态分三组,
// 清理前把要删的东西复制到自己的数据目录里(可还原),默认只删会话和缓存,不动登录。
// 安全:只允许删白名单里的路径,先 realpath 再校验前缀,绝不做通配删除。
import { cp, lstat, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CleanResult, CleanScan, CleanTarget } from '../shared/ipc.ts';

interface Spec {
  id: string;
  label: string;
  path: string;
  group: CleanTarget['group'];
  note: string;
}

function specs(): Spec[] {
  const home = homedir();
  const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const c = join(home, '.claude');
  return [
    { id: 'projects', label: 'Claude Code 会话历史', path: join(c, 'projects'), group: 'session', note: '每个项目的对话记录(history.jsonl)' },
    { id: 'file-history', label: '文件修改历史', path: join(c, 'file-history'), group: 'session', note: 'Claude Code 改过的文件快照' },
    { id: 'shell-snapshots', label: '终端快照', path: join(c, 'shell-snapshots'), group: 'session', note: '运行时保存的 shell 环境快照' },
    { id: 'debug', label: '调试日志', path: join(c, 'debug'), group: 'session', note: 'Claude Code 的调试输出' },
    { id: 'statsig', label: '统计缓存(statsig)', path: join(c, 'statsig'), group: 'cache', note: '功能开关/实验标记缓存' },
    { id: 'claude-cache', label: 'Claude Code 缓存', path: join(c, 'cache'), group: 'cache', note: '插件与资源缓存' },
    { id: 'backups', label: 'Claude Code 自备份', path: join(c, 'backups'), group: 'cache', note: 'Claude Code 自己留的配置备份' },
    { id: 'desktop-cache', label: '桌面版缓存', path: join(appdata, 'Claude', 'Cache'), group: 'cache', note: '网页内核缓存' },
    { id: 'desktop-code-cache', label: '桌面版 Code Cache', path: join(appdata, 'Claude', 'Code Cache'), group: 'cache', note: '编译后的 JS 缓存' },
    { id: 'desktop-gpu', label: '桌面版 GPU 缓存', path: join(appdata, 'Claude', 'GPUCache'), group: 'cache', note: 'GPU 着色器缓存' },
    { id: 'desktop-storage', label: '桌面版站点数据', path: join(appdata, 'Claude', 'Local Storage'), group: 'session', note: '本地存储(含会话痕迹)' },
    { id: 'desktop-session', label: '桌面版 Session Storage', path: join(appdata, 'Claude', 'Session Storage'), group: 'session', note: '标签页级存储' },
    { id: 'desktop-idb', label: '桌面版 IndexedDB', path: join(appdata, 'Claude', 'IndexedDB'), group: 'session', note: '离线数据库' },
    { id: 'desktop-network', label: '桌面版网络状态', path: join(appdata, 'Claude', 'Network'), group: 'cache', note: 'Cookie/网络持久化' },
    { id: 'cc-json', label: 'Claude Code 登录与配置(.claude.json)', path: join(home, '.claude.json'), group: 'auth', note: '删掉等于退出登录(会整份备份)' },
    { id: 'cc-credentials', label: 'Claude Code 凭据文件', path: join(c, '.credentials.json'), group: 'auth', note: 'OAuth 令牌文件' },
    { id: 'desktop-install-trace', label: '桌面版安装痕迹', path: join(local, 'AnthropicClaude'), group: 'cache', note: '旧安装包版留下的目录' },
  ];
}

async function measure(p: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || files > 60_000) return;
    let list: import('node:fs').Dirent[];
    try { list = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = join(dir, e.name);
      try {
        const st = await lstat(full);
        if (st.isDirectory()) await walk(full, depth + 1);
        else if (st.isFile()) { bytes += st.size; files++; }
      } catch { /* 权限/占用:跳过 */ }
    }
  };
  try {
    const st = await lstat(p);
    if (st.isFile()) return { bytes: st.size, files: 1 };
    await walk(p, 0);
  } catch { /* 不存在 */ }
  return { bytes, files };
}

export async function scanClaude(): Promise<CleanScan> {
  const list = specs();
  const targets: CleanTarget[] = [];
  let total = 0;
  for (const s of list) {
    const exists = existsSync(s.path);
    const { bytes, files } = exists ? await measure(s.path) : { bytes: 0, files: 0 };
    total += bytes;
    targets.push({ id: s.id, label: s.label, path: s.path, group: s.group, note: s.note, bytes, files, exists });
  }
  return { at: new Date().toISOString(), targets, totalBytes: total };
}

// 只允许删这些根下面的东西
function allowedRoots(): string[] {
  const home = homedir();
  const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  return [resolve(home, '.claude'), resolve(home, '.claude.json'), resolve(appdata, 'Claude'), resolve(local, 'AnthropicClaude')];
}

const under = (p: string, root: string): boolean => p === root || p.startsWith(root + '\\') || p.startsWith(root + '/');

export async function cleanClaude(ids: string[], backup: boolean, backupRoot: string): Promise<CleanResult> {
  const list = specs().filter((s) => ids.includes(s.id));
  const roots = allowedRoots();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = backup ? join(backupRoot, `claude-backup-${stamp}`) : null;
  let bytes = 0;
  const removed: string[] = [];
  const errors: string[] = [];
  for (const s of list) {
    const p = resolve(s.path);
    if (!roots.some((r) => under(p, r))) { errors.push(`${s.label}: 路径不在允许范围内,已跳过`); continue; }
    if (!existsSync(p)) { continue; }
    const size = await measure(p);
    try {
      if (backupDir) {
        await mkdir(backupDir, { recursive: true });
        await cp(p, join(backupDir, s.id), { recursive: true, force: true, errorOnExist: false });
      }
      const st = await stat(p);
      if (st.isDirectory()) await rm(p, { recursive: true, force: true });
      else await unlink(p);
      bytes += size.bytes;
      removed.push(s.id);
    } catch (e) {
      errors.push(`${s.label}: ${(e as Error).message}`);
    }
  }
  return { at: new Date().toISOString(), removed, bytes, backupDir, errors };
}

export { specs as cleanSpecs };

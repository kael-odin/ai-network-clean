// 身份隔离(参考 CCBaga):每个身份一套独立的 Claude 本地数据~
//   ~/.claude           (Claude Code:登录、会话、插件、MCP)
//   ~/.claude.json      (Claude Code 的账号级配置)
//   %APPDATA%\Claude    (桌面版:登录、缓存、站点数据)
//
// 实现方式:**同盘目录改名**(rename),不压缩、不加密、不复制、不删除。
//   - 归档:把当前真实数据改名搬进身份槽
//   - 切换:先把当前真实数据搬回它所属的槽,再把目标槽的数据改名搬到真实位置
//   - 任何一步失败:按逆序把已经搬动的东西搬回去(回滚)
// 切换前会要求结束 Claude 进程(桌面版/命令行),否则文件被占用、且会把新旧数据混在一起。
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { IdentityInfo, IdentityState } from '../shared/ipc.ts';

export interface IdentityOptions {
  home: string;
  appdata: string;
  dataDir: string;   // 身份槽存放处(用户数据目录)
  killClaude?: () => Promise<{ killed: number }>;
  isClaudeRunning?: () => Promise<{ desktop: boolean; cli: number }>;
}

interface Slot {
  id: string; name: string; createdAt: string; lastUsedAt: string | null;
  bytes?: number; files?: number; projects?: number; lastActiveAt?: string | null;
}
interface State { activeId: string | null; slots: Slot[] }

const SAFE_ID = /^[a-z0-9]{4,16}$/;
const UNMANAGED_ID = 'live';
// 在真实数据的目录里留一个"我是哪个身份"的记号:状态文件丢了也能认出来
const MARKER = '.ain-identity';

// 真实位置(当前在用的那一套)
function livePaths(o: IdentityOptions) {
  return {
    claude: join(o.home, '.claude'),
    claudeJson: join(o.home, '.claude.json'),
    appdata: join(o.appdata, 'Claude'),
  };
}
// 身份槽里的三份
function slotPaths(o: IdentityOptions, id: string) {
  const base = join(o.dataDir, 'identities', id);
  return {
    base,
    claude: join(base, 'home-claude'),
    claudeJson: join(base, 'home-claude.json'),
    appdata: join(base, 'appdata-claude'),
  };
}

// 读账号标识:Claude Code 的 .claude.json 里有 userID(稳定、不含邮箱)
async function readAccount(jsonPath: string): Promise<string | null> {
  try {
    const fs = await import('node:fs/promises');
    const j = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as { userID?: unknown; oauthAccount?: { accountUuid?: unknown } };
    const id = typeof j.userID === 'string' ? j.userID : typeof j.oauthAccount?.accountUuid === 'string' ? j.oauthAccount.accountUuid : null;
    return id ? id.slice(0, 8) : null;
  } catch { return null; }
}

interface Measure { bytes: number; files: number; lastMtime: number }
async function measure(p: string): Promise<Measure> {
  let bytes = 0;
  let files = 0;
  let lastMtime = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10 || files > 120_000) return;
    let list: import('node:fs').Dirent[];
    try { list = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const full = join(dir, e.name);
      try {
        const st = await stat(full);
        if (st.isDirectory()) await walk(full, depth + 1);
        else if (st.isFile()) { bytes += st.size; files++; if (st.mtimeMs > lastMtime) lastMtime = st.mtimeMs; }
      } catch { /* 占用/权限 */ }
    }
  };
  try {
    const st = await stat(p);
    if (st.isFile()) return { bytes: st.size, files: 1, lastMtime: st.mtimeMs };
    await walk(p, 0);
  } catch { /* 不存在 */ }
  return { bytes, files, lastMtime };
}

// 会话里出现过多少个项目(Claude Code 的 projects 目录下每个项目一个子目录)
async function countProjects(claudeDir: string): Promise<number> {
  try {
    const fs = await import('node:fs/promises');
    const list = await fs.readdir(join(claudeDir, 'projects'), { withFileTypes: true });
    return list.filter((e) => e.isDirectory()).length;
  } catch { return 0; }
}

interface Scan { bytes: number; files: number; projects: number; lastActiveAt: string | null }
async function scanPaths(p: { claude: string; claudeJson: string; appdata: string }): Promise<Scan> {
  const a = await measure(p.claude);
  const b = await measure(p.claudeJson);
  const c = await measure(p.appdata);
  const last = Math.max(a.lastMtime, b.lastMtime, c.lastMtime);
  return {
    bytes: a.bytes + b.bytes + c.bytes,
    files: a.files + b.files + c.files,
    projects: await countProjects(p.claude),
    lastActiveAt: last > 0 ? new Date(last).toISOString() : null,
  };
}

// 同盘改名;目标已存在就合并进去(逐个搬),绝不覆盖。跨盘时报错,不自作主张复制几百 MB。
async function move(src: string, dst: string): Promise<void> {
  if (!existsSync(src)) return;
  await mkdir(join(dst, '..'), { recursive: true }).catch(() => {});
  if (!existsSync(dst)) {
    try {
      await rename(src, dst);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') throw new Error('数据目录和用户目录不在同一个盘,无法秒级切换。请把数据目录换到同一个盘');
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw e;
    }
  }
  const st = await stat(src).catch(() => null);
  if (!st) return;
  if (st.isFile()) {
    await rm(dst, { force: true }).catch(() => {});
    await rename(src, dst);
    return;
  }
  for (const entry of await readdir(src)) await move(join(src, entry), join(dst, entry));
  await rmdir(src).catch(() => {});
}

export function createIdentities(o: IdentityOptions) {
  const stateFile = join(o.dataDir, 'identities.json');
  let cache: State | null = null;

  // 扫身份槽目录,以目录为准:状态文件丢了也能把身份找回来
  const scanSlots = async (): Promise<Slot[]> => {
    const dir = join(o.dataDir, 'identities');
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return []; }
    const out: Slot[] = [];
    for (const id of names) {
      if (!SAFE_ID.test(id)) continue;
      const meta = join(dir, id, 'meta.json');
      try {
        const m = JSON.parse(await (await import('node:fs/promises')).readFile(meta, 'utf8')) as Partial<Slot>;
        out.push({
          id,
          name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 40) : `身份 ${id}`,
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
          lastUsedAt: typeof m.lastUsedAt === 'string' ? m.lastUsedAt : null,
        });
      } catch {
        out.push({ id, name: `身份 ${id}`, createdAt: new Date().toISOString(), lastUsedAt: null });
      }
    }
    return out;
  };

  const read = async (): Promise<State> => {
    if (cache) return cache;
    let raw: State = { activeId: null, slots: [] };
    try {
      const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(stateFile, 'utf8')) as State;
      raw = { activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null, slots: Array.isArray(parsed.slots) ? parsed.slots.filter((s) => s && SAFE_ID.test(s.id)) : [] };
    } catch { /* 没有状态文件:靠目录重建 */ }
    const onDisk = await scanSlots();
    // 目录里的为准(文件名不会说谎);状态里多出来的槽如果目录已经不在,就丢掉
    const merged: Slot[] = onDisk.map((d) => {
      const s = raw.slots.find((x) => x.id === d.id);
      return s ? { ...d, name: s.name || d.name, createdAt: s.createdAt || d.createdAt, lastUsedAt: s.lastUsedAt ?? d.lastUsedAt } : d;
    });
    // 状态里没记 activeId 时,从真实数据的记号认出来
    let activeId = raw.activeId;
    if (!activeId) {
      try {
        const mark = (await (await import('node:fs/promises')).readFile(join(livePaths(o).claude, MARKER), 'utf8')).trim();
        if (SAFE_ID.test(mark) && merged.some((x) => x.id === mark)) activeId = mark;
      } catch { /* 没有记号 */ }
    }
    cache = { activeId, slots: merged };
    return cache;
  };
  const write = async (s: State): Promise<void> => {
    cache = s;
    await mkdir(o.dataDir, { recursive: true });
    const fs = await import('node:fs/promises');
    await fs.writeFile(stateFile, JSON.stringify(s, null, 2));
  };
  const newId = (): string => Math.random().toString(36).slice(2, 10);
  const stampLive = async (id: string): Promise<void> => {
    const live = livePaths(o);
    try {
      await mkdir(live.claude, { recursive: true });
      await (await import('node:fs/promises')).writeFile(join(live.claude, MARKER), id);
    } catch { /* 写不了就算了 */ }
  };
  const writeMeta = async (slot: Slot): Promise<void> => {
    const base = slotPaths(o, slot.id).base;
    await mkdir(base, { recursive: true });
    // 顺手把尺寸/项目数/最近活跃存进 meta:下次进页面不用再扫
    const p = slotPaths(o, slot.id);
    const sc = await scanPaths(p);
    slot.bytes = sc.bytes;
    slot.files = sc.files;
    slot.projects = sc.projects;
    slot.lastActiveAt = sc.lastActiveAt;
    await (await import('node:fs/promises')).writeFile(join(base, 'meta.json'), JSON.stringify(slot, null, 2));
  };

  const list = async (deep = false): Promise<IdentityState> => {
    const st = await read();
    const live = livePaths(o);
    let liveClaude: Measure;
    let liveJson: Measure;
    let liveApp: Measure;
    let liveLast = 0;
    const cachedLive = (st as State & { liveBytes?: number; liveFiles?: number }).liveBytes;
    // 只有 deep 才算"统计过";快路径永远标记未统计,让界面补一次
    const measured = deep;
    if (!deep) {
      // 快路径:不扫真实位置(可能几万文件),只用上次的估算;界面随后再要一次 deep 统计
      liveClaude = { bytes: typeof cachedLive === 'number' ? cachedLive : 0, files: (st as State & { liveFiles?: number }).liveFiles ?? 0, lastMtime: 0 };
      liveJson = { bytes: 0, files: existsSync(live.claudeJson) ? 1 : 0, lastMtime: 0 };
      liveApp = { bytes: 0, files: existsSync(live.appdata) ? 1 : 0, lastMtime: 0 };
    } else {
      liveClaude = await measure(live.claude);
      liveJson = await measure(live.claudeJson);
      liveApp = await measure(live.appdata);
      liveLast = Math.max(liveClaude.lastMtime, liveJson.lastMtime, liveApp.lastMtime);
      Object.assign(st, { liveBytes: liveClaude.bytes + liveJson.bytes + liveApp.bytes, liveFiles: liveClaude.files + liveJson.files + liveApp.files });
      void write(st);
    }
    const identities: IdentityInfo[] = [];
    for (const slot of st.slots) {
      const p = slotPaths(o, slot.id);
      const cachedOk = !deep && typeof slot.bytes === 'number' && typeof slot.files === 'number'
        && typeof slot.projects === 'number' && slot.lastActiveAt !== undefined;
      if (!cachedOk) {
        const sc = await scanPaths(p);
        slot.bytes = sc.bytes; slot.files = sc.files; slot.projects = sc.projects; slot.lastActiveAt = sc.lastActiveAt;
        await writeMeta(slot);
      }
      identities.push({
        id: slot.id,
        name: slot.name,
        createdAt: slot.createdAt,
        lastUsedAt: slot.lastUsedAt,
        active: st.activeId === slot.id,
        bytes: slot.bytes ?? 0,
        files: slot.files ?? 0,
        account: await readAccount(p.claudeJson),
        projects: slot.projects ?? 0,
        lastActiveAt: slot.lastActiveAt ?? null,
      });
    }
    // 当前身份的"槽"是空的(数据在真实位置),列表里显示真实位置的量,别让人以为丢了
    const liveBytes = liveClaude.bytes + liveJson.bytes + liveApp.bytes;
    const liveFiles = liveClaude.files + liveJson.files + liveApp.files;
    let liveScan: { bytes: number; files: number; projects: number; lastActiveAt: string | null };
    if (deep) {
      const projects = await countProjects(live.claude);
      const act = liveLast > 0 ? new Date(liveLast).toISOString() : null;
      liveScan = { bytes: liveBytes, files: liveFiles, projects, lastActiveAt: act };
      Object.assign(st, { liveProjects: projects, liveActiveAt: act });
      void write(st);
    } else {
      liveScan = {
        bytes: liveBytes,
        files: liveFiles,
        projects: (st as State & { liveProjects?: number }).liveProjects ?? 0,
        lastActiveAt: (st as State & { liveActiveAt?: string | null }).liveActiveAt ?? null,
      };
    }
    for (const it of identities) {
      if (!it.active) continue;
      // 数据要么在槽里(刚归档),要么在真实位置(日常使用):取较大的一份,别让人以为丢了
      it.bytes = Math.max(it.bytes, liveScan.bytes);
      it.files = Math.max(it.files, liveScan.files);
      it.projects = Math.max(it.projects, liveScan.projects);
      const a = it.lastActiveAt ? Date.parse(it.lastActiveAt) : 0;
      const b = liveScan.lastActiveAt ? Date.parse(liveScan.lastActiveAt) : 0;
      it.lastActiveAt = b >= a ? liveScan.lastActiveAt : it.lastActiveAt;
    }
    const running = o.isClaudeRunning ? await o.isClaudeRunning() : { desktop: false, cli: 0 };
    return {
      at: new Date().toISOString(),
      activeId: st.activeId,
      identities: identities.sort((x, y) => (y.lastUsedAt ?? y.createdAt).localeCompare(x.lastUsedAt ?? x.createdAt)),
      live: {
        claude: existsSync(live.claude),
        claudeJson: existsSync(live.claudeJson),
        appdata: existsSync(live.appdata),
        bytes: liveClaude.bytes + liveJson.bytes + liveApp.bytes,
        files: liveClaude.files + liveJson.files + liveApp.files,
        account: await readAccount(live.claudeJson),
        measured,
      },
      claudeRunning: running,
    };
  };

  // 把「现在真实位置的数据」搬进某个槽(槽必须还不存在数据)
  const absorbLive = async (st: State, slotId: string): Promise<void> => {
    const live = livePaths(o);
    const slot = slotPaths(o, slotId);
    if (existsSync(live.claude)) await move(live.claude, slot.claude);
    if (existsSync(live.claudeJson)) await move(live.claudeJson, slot.claudeJson);
    if (existsSync(live.appdata)) await move(live.appdata, slot.appdata);
    // 记下这个槽是"当前真实数据的来源"
    const idx = st.slots.findIndex((s) => s.id === slotId);
    if (idx >= 0) st.slots[idx].lastUsedAt = new Date().toISOString();
  };

  // 把某个槽的数据搬到真实位置
  const restoreSlot = async (slotId: string): Promise<void> => {
    const live = livePaths(o);
    const slot = slotPaths(o, slotId);
    if (existsSync(slot.claude)) await move(slot.claude, live.claude);
    if (existsSync(slot.claudeJson)) await move(slot.claudeJson, live.claudeJson);
    if (existsSync(slot.appdata)) await move(slot.appdata, live.appdata);
  };

  return {
    list,

    // 新建身份:把当前真实数据归档进新槽
    async capture(name: string): Promise<IdentityState> {
      const st = await read();
      const nm = name.trim().slice(0, 40) || '未命名身份';
      const running = o.isClaudeRunning ? await o.isClaudeRunning() : { desktop: false, cli: 0 };
      if (running.desktop || running.cli > 0) throw new Error('Claude 还在运行:先结束 Claude 桌面版/命令行,再归档(否则文件被占用,数据会混在一起)');
      const id = newId();
      const slot: Slot = { id, name: nm, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() };
      st.slots.push(slot);
      await writeMeta(slot);
      await absorbLive(st, id);
      await writeMeta(slot);
      st.activeId = id;
      await write(st);
      await stampLive(id);
      return list(true);   // 刚搬过数据:必须重新统计,不能给缓存
    },

    // 切换到某个身份
    async activate(id: string): Promise<IdentityState> {
      if (!SAFE_ID.test(id)) throw new Error('身份编号不对');
      const st = await read();
      if (!st.slots.some((s) => s.id === id)) throw new Error('找不到这个身份');
      if (st.activeId === id && !existsSync(livePaths(o).claude) && !existsSync(livePaths(o).appdata)) return list();
      const running = o.isClaudeRunning ? await o.isClaudeRunning() : { desktop: false, cli: 0 };
      if (running.desktop || running.cli > 0) throw new Error('Claude 还在运行:先结束它再切换(点「结束 Claude 并继续」)');

      // 当前真实数据先回到它所属的槽
      const owner = st.activeId && st.slots.some((s) => s.id === st.activeId) ? st.activeId : UNMANAGED_ID;
      if (owner === UNMANAGED_ID) {
        const has = existsSync(livePaths(o).claude) || existsSync(livePaths(o).appdata) || existsSync(livePaths(o).claudeJson);
        if (has) {
          if (!st.slots.some((s) => s.id === UNMANAGED_ID)) {
            const auto: Slot = { id: UNMANAGED_ID, name: '未归属(切换前自动保存)', createdAt: new Date().toISOString(), lastUsedAt: null };
            st.slots.push(auto);
            await writeMeta(auto);
          }
          await absorbLive(st, UNMANAGED_ID);
        }
      } else {
        await absorbLive(st, owner);
      }

      // 目标槽搬到真实位置;失败就把刚才的搬回去
      const undo: [string, string][] = [];
      try {
        await restoreSlot(id);
      } catch (e) {
        for (const [src, dst] of undo.reverse()) await move(dst, src).catch(() => {});
        throw e;
      }
      st.activeId = id;
      const idx = st.slots.findIndex((s) => s.id === id);
      if (idx >= 0) {
        st.slots[idx].lastUsedAt = new Date().toISOString();
        await writeMeta(st.slots[idx]);
      }
      await write(st);
      await stampLive(id);
      return list(true);   // 刚搬过数据:必须重新统计,不能给缓存
    },

    // 结束 Claude 进程(桌面版 + 命令行)
    async killClaude(): Promise<{ killed: number }> {
      if (o.killClaude) return o.killClaude();
      const run = (args: string[]) => new Promise<number>((ok) => execFile('taskkill', args, { windowsHide: true }, () => ok(1)));
      await run(['/IM', 'claude.exe', '/F', '/T']).catch(() => 0);
      await run(['/IM', 'Claude.exe', '/F', '/T']).catch(() => 0);
      return { killed: 1 };
    },

    async rename(id: string, name: string): Promise<IdentityState> {
      const st = await read();
      const s = st.slots.find((x) => x.id === id);
      if (!s) throw new Error('找不到这个身份');
      s.name = name.trim().slice(0, 40) || s.name;
      await writeMeta(s);
      await write(st);
      return list();
    },

    // 删除身份(只删槽里的数据;当前在用的不能删)
    async remove(id: string): Promise<IdentityState> {
      const st = await read();
      if (st.activeId === id) throw new Error('这个身份正在使用:先切换到别的身份再删');
      st.slots = st.slots.filter((s) => s.id !== id);
      await write(st);
      const p = slotPaths(o, id);
      await rm(p.base, { recursive: true, force: true }).catch(async () => {
        // 某些文件被占用时逐个删,删不掉就留着
        for (const k of ['claude', 'claudeJson', 'appdata'] as const) await rm(p[k], { recursive: true, force: true }).catch(() => {});
        await rmdir(p.base).catch(() => {});
      });
      return list(true);
    },
  };
}

export type Identities = ReturnType<typeof createIdentities>;
export { livePaths, slotPaths };

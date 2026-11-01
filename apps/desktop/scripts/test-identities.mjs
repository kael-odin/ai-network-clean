// 身份隔离的离线测试:全部在临时目录里跑,不碰真实的 ~/.claude
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIdentities } from '../src/main/identities.ts';

const root = join(tmpdir(), `ain-id-test-${Date.now()}`);
const home = join(root, 'home');
const appdata = join(root, 'appdata');
const data = join(root, 'data');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) fail++; };
const has = (p) => existsSync(p);

const id = createIdentities({ home, appdata, dataDir: data, isClaudeRunning: async () => ({ desktop: false, cli: 0 }) });

// 造一套「账号 A」的数据
await mkdir(join(home, '.claude', 'projects'), { recursive: true });
await writeFile(join(home, '.claude', 'projects', 'a.jsonl'), 'A-SESSION');
await writeFile(join(home, '.claude', '.credentials.json'), 'A-CRED');
await writeFile(join(home, '.claude.json'), '{"oauthAccount":"A"}');
await mkdir(join(appdata, 'Claude', 'Cache'), { recursive: true });
await writeFile(join(appdata, 'Claude', 'Cache', 'x'), 'A-CACHE');

console.log('\n[1] 初始状态');
let s = await id.list();
ok(s.identities.length === 0, '没有身份');
ok(s.live.claude && s.live.claudeJson && s.live.appdata, '检测到真实位置有数据');

console.log('\n[2] 把 A 归档为身份');
s = await id.capture('账号 A');
ok(s.identities.length === 1 && s.identities[0].active, '创建了 1 个身份且标记为当前');
ok(!has(join(home, '.claude', 'projects')) && !has(join(home, '.claude', '.credentials.json')) && !has(join(appdata, 'Claude')) && !has(join(home, '.claude.json')), '真实位置只剩身份记号,业务数据已搬走(不是复制)');
ok(has(join(home, '.claude', '.ain-identity')), '真实数据里留了「我是哪个身份」的记号(状态文件丢了也能认回来)');
ok(s.identities[0].files >= 4, `身份槽里有 ${s.identities[0].files} 个文件`);

// 造「账号 B」的数据(模拟换号登录)
await mkdir(join(home, '.claude', 'projects'), { recursive: true });
await writeFile(join(home, '.claude', 'projects', 'b.jsonl'), 'B-SESSION');
await writeFile(join(home, '.claude.json'), '{"oauthAccount":"B"}');
s = await id.capture('账号 B');
ok(s.identities.length === 2, '现在是 2 个身份');

console.log('\n[3] 切回 A');
const a = s.identities.find((x) => x.name === '账号 A');
await id.activate(a.id);
const aSession = await readFile(join(home, '.claude', 'projects', 'a.jsonl'), 'utf8').catch(() => '');
ok(aSession === 'A-SESSION', '真实位置换成了 A 的会话');
ok(!has(join(home, '.claude', 'projects', 'b.jsonl')), 'B 的会话不在真实位置(彻底隔离)');
ok((await readFile(join(home, '.claude.json'), 'utf8').catch(() => '')) === '{"oauthAccount":"A"}', '.claude.json 也是 A 的');

console.log('\n[4] 再切回 B');
const b = s.identities.find((x) => x.name === '账号 B');
await id.activate(b.id);
ok((await readFile(join(home, '.claude', 'projects', 'b.jsonl'), 'utf8').catch(() => '')) === 'B-SESSION', '真实位置换成了 B 的会话');
ok(!has(join(home, '.claude', 'projects', 'a.jsonl')), 'A 的会话不在真实位置');

console.log('\n[5] 重命名 / 删除');
await id.rename(b.id, '工作号');
s = await id.list();
ok(s.identities.some((x) => x.name === '工作号' && x.id === b.id), '重命名成功');
let threw = false;
try { await id.remove(b.id); } catch { threw = true; }
ok(threw, '拒绝删除当前在用的身份');
await id.activate(a.id);
await id.remove(b.id);
s = await id.list();
ok(s.identities.length === 1, '删除非当前身份成功');

console.log('\n[6] 未归属数据自动保护');
await rm(join(data, 'identities.json'), { force: true });
// 模拟首次使用:真实位置有文件,但状态文件丢了
await id.list();
await mkdir(join(home, '.claude', 'projects'), { recursive: true });
await writeFile(join(home, '.claude', 'projects', 'orphan.jsonl'), 'ORPHAN');
const fresh = createIdentities({ home, appdata, dataDir: data, isClaudeRunning: async () => ({ desktop: false, cli: 0 }) });
const s2 = await fresh.list();
await fresh.activate(a.id);
const liveNow = await readFile(join(home, '.claude', 'projects', 'a.jsonl'), 'utf8').catch(() => '');
ok(liveNow === 'A-SESSION', '状态丢失后仍能切回 A');
ok(liveNow === 'A-SESSION', '切换后真实位置是 A 的会话');
// 孤儿数据(状态文件丢失期间写下的)不能丢:它会被并进当时认出来的身份(A)
import { readdir as rd } from 'node:fs/promises';
let found = has(join(home, '.claude', 'projects', 'orphan.jsonl'));
for (const slotDir of await rd(join(data, 'identities'))) {
  if (has(join(data, 'identities', slotDir, 'home-claude', 'projects', 'orphan.jsonl'))) found = true;
}
ok(found, '孤儿数据还在(无论在真实位置还是身份槽里),没有丢');

console.log('\n[7] Claude 在跑时拒绝切换');
const busy = createIdentities({ home, appdata, dataDir: data, isClaudeRunning: async () => ({ desktop: true, cli: 0 }) });
let blocked = false;
try { await busy.activate(a.id); } catch { blocked = true; }
ok(blocked, '有 Claude 在跑时会拒绝,提示先结束进程');

await rm(root, { recursive: true, force: true }).catch(() => {});
console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项失败 ✗`);
process.exit(fail === 0 ? 0 : 1);

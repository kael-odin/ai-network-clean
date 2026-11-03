// 回归测试:Node 24+ 直接跑 .ts(node --test)
// 全部在临时目录里跑,不碰真实的 ~/.claude、不改系统设置
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIdentities } from '../src/main/identities.ts';
import { fixClaudeCode, undoClaudeCode } from '../src/main/claudecode.ts';
import { createSysDns } from '../src/main/sysdns.ts';
import { decideTun } from '../src/main/conflict.ts';

test('TUN 决策:Clash 在运行但开关全关(没有隧道网卡)时照常起 TUN', () => {
  const r = decideTun('auto', true, null, ['clash-verge.exe', 'verge-mihomo.exe'], 17897);
  assert.equal(r.tun, true, '应该起 TUN');
  assert.equal(r.mode, 'tun');
  assert.match(r.warning ?? '', /在运行但没接管流量/, '提示里说明不影响');
});

test('TUN 决策:别的隧道网卡在线时退回本地代理', () => {
  const r = decideTun('auto', true, 'Meta', [], 17897);
  assert.equal(r.tun, false, '有别的 TUN 时不起');
  assert.equal(r.mode, 'proxy');
  assert.match(r.warning ?? '', /Meta.*接管全局流量/);
});

test('TUN 决策:没有管理员权限时退回本地代理', () => {
  const r = decideTun('auto', false, null, [], 17897);
  assert.equal(r.tun, false);
  assert.match(r.warning ?? '', /管理员/);
});

test('TUN 决策:设置里关掉虚拟网卡时用本地代理', () => {
  const r = decideTun('off', true, null, [], 17897);
  assert.equal(r.tun, false);
  assert.equal(r.mode, 'proxy');
});

const GUID_A = '11111111-1111-1111-1111-111111111111';
const GUID_B = '22222222-2222-2222-2222-222222222222';

async function scratch(name: string): Promise<string> {
  const dir = join(tmpdir(), `ain-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

test('身份删除:编号不合法/越界时拒绝,且不动数据', async () => {
  const root = await scratch('id-remove');
  const home = join(root, 'home'), data = join(root, 'data');
  const id = createIdentities({ home, appdata: join(root, 'appdata'), dataDir: data, isClaudeRunning: async () => ({ desktop: false, cli: 0 }) });
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 'a.jsonl'), 'A');
  const a = (await id.capture('A')).identities[0].id;
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 'b.jsonl'), 'B');
  await id.capture('B');

  const archived = join(data, 'identities', a, 'home-claude', 'projects', 'a.jsonl');
  await assert.rejects(() => id.remove(''), /编号不对/);
  await assert.rejects(() => id.remove('..'), /编号不对/);
  await assert.rejects(() => id.remove('../../settings'), /编号不对/);
  await assert.rejects(() => id.remove('doesnotexist'), /找不到/);
  assert.equal(existsSync(archived), true, '归档数据还在');
  assert.equal(existsSync(join(data, 'identities.json')), true, '数据目录没被删');
  await rm(root, { recursive: true, force: true });
});

test('切换身份:中途搬不过去时整笔回滚,真实位置和槽都不留半截数据', async () => {
  const root = await scratch('id-rollback');
  const home = join(root, 'home'), appdata = join(root, 'appdata'), data = join(root, 'data');
  const id = createIdentities({ home, appdata, dataDir: data, isClaudeRunning: async () => ({ desktop: false, cli: 0 }) });
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 'a.jsonl'), 'A');
  const a = (await id.capture('A')).identities[0].id;
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 'b.jsonl'), 'B');
  const b = (await id.capture('B')).identities.find((x) => x.id !== a)!.id;

  // B 是当前身份:真实位置又写进了新数据(切换前最后一次使用)。
  // 同时把 B 槽里的 appdata 位置换成一个普通文件:切换时先搬 .claude(目录)、再搬 .claude.json,
  // 最后搬 %APPDATA%\Claude —— 目录往一个文件上搬必然失败,此时前两步已经搬走了,必须整笔回滚
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 'b2.jsonl'), 'B2');
  await writeFile(join(home, '.claude.json'), '{"b":2}');
  await mkdir(join(appdata, 'Claude', 'Cache'), { recursive: true });
  await writeFile(join(appdata, 'Claude', 'Cache', 'x'), 'B-CACHE');
  const slotB = join(data, 'identities', b);
  await rm(join(slotB, 'appdata-claude'), { recursive: true, force: true });
  await writeFile(join(slotB, 'appdata-claude'), 'blocker');

  await assert.rejects(() => id.activate(a), /被一个文件占着|搬不动|占用/);

  // 回滚:已经搬进 B 槽的要搬回真实位置。B 归档时数据都已经在 B 槽里,
  // 切换前真实位置那次新写入(b2 / .claude.json)必须原地还在,不能出现在 A 的槽里
  assert.equal(await readFile(join(home, '.claude', 'projects', 'b2.jsonl'), 'utf8').catch(() => ''), 'B2', '真实位置那次写入还在');
  assert.equal(await readFile(join(home, '.claude.json'), 'utf8').catch(() => ''), '{"b":2}', '.claude.json 回到了真实位置');
  assert.equal(await readFile(join(appdata, 'Claude', 'Cache', 'x'), 'utf8').catch(() => ''), 'B-CACHE', '桌面版数据没被搬走');
  assert.equal(await readFile(join(slotB, 'appdata-claude'), 'utf8'), 'blocker', 'B 槽的占位文件原样还在');
  assert.equal(existsSync(join(slotB, 'home-claude', 'projects', 'b.jsonl')), true, 'B 归档的会话还在 B 槽');
  assert.equal(existsSync(join(data, 'identities', a, 'home-claude', 'projects', 'b2.jsonl')), false, 'A 的槽里没有别人的数据');
  await rm(root, { recursive: true, force: true });
});

test('Claude Code 设置:文件读不懂时拒绝修改,原文件和原备份都不动', async () => {
  const root = await scratch('cc-settings');
  const prevHome = process.env.USERPROFILE, prevHome2 = process.env.HOME;
  process.env.USERPROFILE = root; process.env.HOME = root;
  try {
    const { setBackupDir } = await import('../src/main/claudecode.ts');
    setBackupDir(root);
    const file = join(root, '.claude', 'settings.json');
    await mkdir(join(root, '.claude'), { recursive: true });
    const broken = '{ "permissions": { "allow": ["Bash(ls)"] }, }\n'; // 尾逗号:非法 JSON
    await writeFile(file, broken);
    assert.throws(() => fixClaudeCode(17897), /不是合法的 JSON/);
    assert.equal(await readFile(file, 'utf8'), broken, '原文件一字未动');
    assert.equal(existsSync(file + '.ain-backup'), false, '没留下错误的备份');
    assert.equal(existsSync(join(root, 'claudecode-proxy-backup.json')), false, '没登记成「已修正」');

    // 正常文件:修正 → 撤销,原内容完整回来,其它字段不丢
    const good = { permissions: { allow: ['Bash(ls)'] }, model: 'opus', env: { FOO: '1' } };
    await writeFile(file, JSON.stringify(good, null, 2));
    fixClaudeCode(17897);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).env.HTTPS_PROXY, 'http://127.0.0.1:17897');
    undoClaudeCode();
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), good);
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevHome;
    if (prevHome2 === undefined) delete process.env.HOME; else process.env.HOME = prevHome2;
    await rm(root, { recursive: true, force: true });
  }
});

test('DNS 还原:DHCP 网卡只重置,手工配置的网卡写回原地址', async () => {
  const root = await scratch('sysdns');
  const calls: string[] = [];
  const fakePs = async (cmd: string): Promise<string> => {
    calls.push(cmd);
    if (cmd.includes('Get-NetAdapter')) {
      // 格式:guid|name|v4|v6|ifIndex|手工DNS个数
      return [
        `${GUID_A}|以太网|192.168.1.1,192.168.0.1||12|0`,   // DHCP 下发的
        `${GUID_B}|WLAN|203.0.113.53||13|1`,                // 手工写死的
      ].join('\r\n');
    }
    return '';
  };
  const dns = createSysDns(root, fakePs);
  const names = await dns.apply();
  assert.deepEqual(names, ['以太网', 'WLAN']);
  calls.length = 0;
  await dns.restore();
  const joined = calls.join('\n');
  assert.match(joined, new RegExp(`InterfaceGuid '${GUID_A}' -ResetServerAddresses`), 'DHCP 网卡重置');
  assert.doesNotMatch(joined, new RegExp(`InterfaceGuid '${GUID_A}' .*-ServerAddresses 192\\.168`), 'DHCP 网卡不写回');
  assert.match(joined, new RegExp(`InterfaceGuid '${GUID_B}' -ServerAddresses 203\\.0\\.113\\.53`), '手工网卡写回');
  assert.equal(dns.pending(), false, '还原后备份文件已删除');
  await rm(root, { recursive: true, force: true });
});

test('DNS 还原:备份文件里的坏数据不会拼进命令', async () => {
  const root = await scratch('sysdns-bad');
  const calls: string[] = [];
  const fakePs = async (cmd: string): Promise<string> => { calls.push(cmd); return ''; };
  await writeFile(join(root, 'sysdns-backup.json'), JSON.stringify({
    at: '', adapters: [
      { guid: "' ; Remove-Item C:\\ -Recurse ; '", name: 'x', servers: ['1.1.1.1'], static: true },
      { guid: GUID_A, name: 'ok', servers: ['1.1.1.1; Remove-Item C:\\'], static: true },
    ],
  }));
  const dns = createSysDns(root, fakePs);
  await dns.restore();
  assert.doesNotMatch(calls.join('\n'), /Remove-Item/, '非法 GUID/地址被丢掉');
  await rm(root, { recursive: true, force: true });
});

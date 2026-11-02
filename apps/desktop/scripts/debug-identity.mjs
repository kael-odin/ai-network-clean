import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentities } from '../src/main/identities.ts';

const root = await mkdtemp(join(tmpdir(), 'ain-dbg-'));
const home = join(root, 'home');
const appdata = join(root, 'appdata');
const data = join(root, 'data');

await mkdir(join(home, '.claude', 'projects'), { recursive: true });
await writeFile(join(home, '.claude', 'projects', 'a.jsonl'), 'A');
await writeFile(join(home, '.claude', '.credentials.json'), 'C');
await writeFile(join(home, '.claude.json'), '{}');
await mkdir(join(appdata, 'Claude', 'Cache'), { recursive: true });
await writeFile(join(appdata, 'Claude', 'Cache', 'x'), 'X');

const id = createIdentities({ home, appdata, dataDir: data, isClaudeRunning: async () => ({ desktop: false, cli: 0 }) });
const s0 = await id.list(false);
console.log('list(false).live =', JSON.stringify(s0.live));

const s1 = await id.capture('A');
const slot = s1.identities[0];
console.log('capture → slot files=', slot.files, 'bytes=', slot.bytes, 'projects=', slot.projects, 'account=', slot.account);

const dir = join(data, 'identities', slot.id);
for (const sub of ['home-claude', 'home-claude.json', 'appdata-claude']) {
  try {
    const st = await (await import('node:fs/promises')).stat(join(dir, sub));
    if (st.isDirectory()) console.log('  ', sub, '→ 目录:', (await readdir(join(dir, sub))).join(','));
    else console.log('  ', sub, '→ 文件', st.size, '字节');
  } catch { console.log('  ', sub, '→ 缺失'); }
}
console.log('  meta:', JSON.stringify(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))));
await rm(root, { recursive: true, force: true }).catch(() => {});

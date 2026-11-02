// 按地区自动选最快(PM 10-30 用户建议):节点页可以把「自动选最快」限定在某个地区,比如只在日本节点里挑延迟最低的。
// 地区从节点名认:国旗表情、中文地名、英文名或缩写。同一份规则既给内核用(url-test 组的 filter,Go 正则),也给界面用(JS 正则)
export interface Region { code: string; label: string; pattern: string }

// 英文缩写前后不能紧挨着字母(避免 RUS 里认出 US);两种正则都支持这种写法
const abbr = (s: string) => `(^|[^A-Za-z])${s}([^A-Za-z]|$)`;
export const REGIONS: Region[] = [
  { code: 'HK', label: '香港', pattern: ['🇭🇰', '香港', 'Hong ?Kong', abbr('HK')].join('|') },
  { code: 'TW', label: '台湾', pattern: ['🇹🇼', '台湾', '台灣', '台北', 'Taiwan', 'Taipei', abbr('TW')].join('|') },
  { code: 'JP', label: '日本', pattern: ['🇯🇵', '日本', '东京', '東京', '大阪', 'Japan', 'Tokyo', 'Osaka', abbr('JP')].join('|') },
  { code: 'SG', label: '新加坡', pattern: ['🇸🇬', '新加坡', '狮城', 'Singapore', abbr('SG')].join('|') },
  { code: 'US', label: '美国', pattern: ['🇺🇸', '美国', '美國', '美西', '美东', '洛杉矶', '圣何塞', '西雅图', '旧金山', '硅谷', '纽约', '芝加哥', '达拉斯', 'United States', 'America', 'Los Angeles', 'San Jose', 'Seattle', 'New York', abbr('US'), abbr('USA')].join('|') },
  { code: 'KR', label: '韩国', pattern: ['🇰🇷', '韩国', '韓國', '首尔', 'Korea', 'Seoul', abbr('KR')].join('|') },
];
export const OTHER = 'OTHER';

const js = (p: string) => new RegExp(p, 'iu');
export function regionOf(name: string): string {
  return REGIONS.find((r) => js(r.pattern).test(name))?.code ?? OTHER;
}
// 给内核的 url-test 组:选了某个地区 → filter;选了「其他」→ 把几个主要地区排除掉(和原有的排除规则合在一起)
export function regionFilter(code: string, exclude: string | undefined): { filter?: string; 'exclude-filter'?: string } {
  if (!code) return {};
  if (code === OTHER) return { 'exclude-filter': '(?i)' + [exclude, ...REGIONS.map((r) => r.pattern)].filter(Boolean).map((p) => `(${p})`).join('|') };
  const r = REGIONS.find((x) => x.code === code);
  return r ? { filter: `(?i)(${r.pattern})` } : {};
}

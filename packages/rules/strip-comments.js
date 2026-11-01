// 发给用户的脚本去掉模板里的全部注释(仓库里的模板保留注释,给我们自己看),只留生成器加在开头的品牌和声明。
// 按字符扫描:字符串、模板字符串、正则字面量里的 // 和 /* 不是注释。
// 正则字面量只出现在 ( , = : [ ! & | ? ; { } 之后或行首(模板里就这么写),其他位置的 / 是除号。
'use strict';
const BS = String.fromCharCode(92);  // 反斜杠
const NL = String.fromCharCode(10);  // 换行
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const REGEX_AFTER = '(,=:[!&|?;{}';

function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = NL; // 上一个有意义的字符,判断 / 是除号还是正则开头
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === BS) j++; j++; }
      out += src.slice(i, j + 1); prev = c; i = j + 1; continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== NL) i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const j = src.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2; continue;
    }
    if (c === '/' && (prev === NL || REGEX_AFTER.includes(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < n && (cls || src[j] !== '/')) {
        if (src[j] === BS) j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        j++;
      }
      out += src.slice(i, j + 1); prev = '/'; i = j + 1; continue;
    }
    out += c;
    if (c !== ' ' && c !== TAB && c !== CR) prev = c;
    i++;
  }
  // 去掉行尾空白;注释删掉后留下的连续空行最多保留一行
  const lines = out.split(NL).map((l) => l.trimEnd());
  const kept = [];
  for (const l of lines) {
    if (l === '' && kept.length && kept[kept.length - 1] === '') continue;
    kept.push(l);
  }
  return kept.join(NL);
}

module.exports = { stripComments };

// 生成应用图标(纯 Node,不依赖任何图形库):圆角方块 + 蓝色渐变 + 白色「AI 出口」意象(环 + 点)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../build/icon.png');
const S = 256;

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const px = Buffer.alloc(S * S * 4);
const inRoundRect = (x, y, r) => {
  const l = 16 + r;
  const rr = S - 16 - r;
  if (x >= l && x <= rr && y >= 16 && y <= S - 16) return true;
  if (y >= l && y <= rr && x >= 16 && x <= S - 16) return true;
  for (const [cx, cy] of [[l, l], [rr, l], [l, rr], [rr, rr]]) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  }
  return false;
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // 圆角方块(半径 56),外面透明
    if (!inRoundRect(x, y, 56)) { px[i + 3] = 0; continue; }
    // 渐变:左上亮蓝 → 右下深蓝
    const t = (x + y) / (2 * S);
    const r = Math.round(47 + (29 - 47) * t);
    const g = Math.round(123 + (78 - 123) * t);
    const b = Math.round(255 + (216 - 255) * t);
    // 白色环(外径 52、线宽 10),中心一个白点(半径 14),右上角一个小缺口表示「出口」
    const dx = x - S / 2;
    const dy = y - S / 2;
    const d = Math.hypot(dx, dy);
    let white = 0;
    if (d <= 58 && d >= 46) {
      const ang = Math.atan2(dy, dx);
      const gap = ang > -0.55 && ang < 0.15; // 右上开口
      if (!gap) white = 1;
    }
    if (d <= 17) white = 1;
    // 开口处再画一小段箭头状的斜线,强化「出去」的意思
    if (d > 40 && d < 66) {
      const ang = Math.atan2(dy, dx);
      if (ang > -0.62 && ang < -0.28) {
        const w = Math.abs((x - S / 2) - (y - S / 2) - 0) < 7 && x > S / 2;
        if (w) white = 1;
      }
    }
    const a = white ? 255 : 0;
    px[i] = Math.round(r * (1 - a / 255) + 255 * (a / 255));
    px[i + 1] = Math.round(g * (1 - a / 255) + 255 * (a / 255));
    px[i + 2] = Math.round(b * (1 - a / 255) + 255 * (a / 255));
    px[i + 3] = 255;
  }
}

// 每行前面加 filter 字节 0
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log('icon written:', out, png.length, 'bytes');

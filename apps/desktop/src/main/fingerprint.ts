// 内置 Claude 窗口的指纹噪声:让 Canvas / WebGL 读数带一个由种子决定的、极微小的扰动。
//
// 为什么:同一台机器上不同账号如果读到完全相同的 Canvas 哈希,是最直接的"同一设备"证据。
// 做法参考主流指纹浏览器——不伪造 UA/硬件(那些容易自相矛盾),只让"像素级读数"带噪声:
//   · 同一个种子 = 同一个指纹(换账号不换设备,避免"每次访问都是新机器"这种更可疑的变化)
//   · 换种子 = 换一台"设备"
//   · 扰动幅度 1/255,肉眼不可见,但足以让 toDataURL / getImageData / readPixels 的哈希不同
//
// 只改"读出来的数据",不改画布本身(否则会影响网站正常绘制)。
export function fingerprintScript(seed: number): string {
  const s = Math.floor(seed) >>> 0 || 12345;
  return `(() => {
  if (window.__ainFp) return;
  window.__ainFp = ${s};
  const SEED = ${s};
  // 确定性伪随机:同一位置每次得到同一个扰动
  const noise = (n) => {
    let x = (n ^ SEED) >>> 0;
    x = (x * 1664525 + 1013904223) >>> 0;
    x ^= x >>> 13;
    x = (x * 1274126177) >>> 0;
    return (x >>> 0) / 4294967295;
  };
  // ±1 个色阶:肉眼不可见,但足以让哈希变化。注意不能用 Math.round(±0.5)——那样永远是 0
  const step = (n) => (noise(n) < 0.5 ? -1 : 1);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // 用「像素本身的颜色」派生扰动,而不是用下标:这样 toDataURL 和 getImageData
  // 对同一块内容会得到同一个结果,不会自相矛盾(自相矛盾恰恰是 CF 判断"被 hook"的依据)
  const jitter = (img, _salt) => {
    if (!img || !img.data || !img.data.length) return;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2] | (i << 24);
      d[i] = clamp(d[i] + step(key));
      d[i + 1] = clamp(d[i + 1] + step(key + 7));
      d[i + 2] = clamp(d[i + 2] + step(key + 13));
    }
  };

  // 1) 2D:getImageData 读出来时加噪(不改源画布)
  try {
    const gid = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const out = gid.apply(this, args);
      try { jitter(out, (args[0] | 0) * 31 + (args[1] | 0) * 7 + this.canvas.width); } catch (e) {}
      return out;
    };
  } catch (e) {}

  // 2) toDataURL / toBlob:先复制到离屏画布、加噪、再导出
  const copyWithNoise = (canvas) => {
    try {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      jitter(img, c.width * 3 + c.height);
      ctx.putImageData(img, 0, 0);
      return c;
    } catch (e) { return canvas; }
  };
  try {
    const td = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      try { return td.apply(copyWithNoise(this), args); } catch (e) { return td.apply(this, args); }
    };
    const tb = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...args) {
      try { return tb.apply(copyWithNoise(this), [cb, ...args]); } catch (e) { return tb.apply(this, [cb, ...args]); }
    };
  } catch (e) {}

  // 3) WebGL:readPixels 出来的第一个像素加噪(足以改哈希)
  try {
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const C = window[name];
      if (!C) continue;
      const rp = C.prototype.readPixels;
      C.prototype.readPixels = function (...args) {
        const r = rp.apply(this, args);
        try {
          const px = args[6];
          if (px && px.length >= 4) {
            const salt = px[0] + px[1] * 3 + px[2] * 7 + px[3] * 11;
            for (let i = 0; i < 4; i++) px[i] = clamp(px[i] + step(i * 17 + salt));
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}
})();`;
}

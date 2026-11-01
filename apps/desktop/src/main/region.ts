// 用户所在国家:创建设备时要填 homeRegion(本地直连的国家)。用 Cloudflare 的 trace 看直连出口的国家,
// 查不到就当 US(用户群以海外为主)。注意这是"直连"出口:用户若开着 VPN,看到的是 VPN 的国家,
// 这时客户端已经在启动时提醒过先关 VPN。
export async function detectRegion(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const r = await fetchImpl('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    const m = text.match(/^loc=([A-Z]{2})$/m);
    if (m) return m[1];
  } catch { /* 网络不通 */ }
  return 'US';
}

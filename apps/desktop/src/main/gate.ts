// AI 闸门的开关判断(PM 10-22「用户频繁被拦截 AI」):
// - 某项「异常」(fail):立刻拦
// - 某项「未确认」(unknown,比如检测服务一时没回、DNS 探测超时):闸门本来关着就继续关着(没确认前不放行);
//   闸门开着时,同一项连续两轮都是未确认才拦,一次偶发的未确认不拦(原来每分钟一轮检测,偶发一次就拦一次 AI)
// - 本地代理模式下 IPv6、WebRTC 只提醒不拦(soft)
import type { CheckState } from '../shared/ipc.ts';
export type { CheckState };

export interface GateDecision { block: string[]; warn: string[]; tolerated: string[] }

const label = (name: string, st: CheckState) => name + (st === 'fail' ? '异常' : '未确认');

// streak:每项连续「未确认」的轮数,调用方保存,跨轮次累计;这里会更新它
export function decideGate(items: [string, CheckState][], soft: string[], wasOpen: boolean, streak: Map<string, number>): GateDecision {
  const block: string[] = [];
  const warn: string[] = [];
  const tolerated: string[] = [];
  for (const [name, st] of items) {
    if (st === 'ok') { streak.delete(name); continue; }
    if (soft.includes(name)) { warn.push(label(name, st)); continue; }
    if (st === 'fail') { streak.delete(name); block.push(label(name, st)); continue; }
    const n = (streak.get(name) ?? 0) + 1;
    streak.set(name, n);
    if (!wasOpen || n >= 2) block.push(label(name, st));
    else tolerated.push(label(name, st));
  }
  return { block, warn, tolerated };
}

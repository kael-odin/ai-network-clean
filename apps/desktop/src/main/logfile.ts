// 内核日志:异步追加 + 大小轮转。
// 长期开着时内核日志会一直长(info 级别、每行连接都写),原来的 appendFileSync 还是在主进程里同步写盘,
// 一次卡顿就是一次界面卡顿。这里改成:写流异步落盘,超过 8MB 就轮转,只留两份(.log / .log.1)
import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export const MAX_LOG_BYTES = 8 * 1024 * 1024;

export function createLogFile(path: string, maxBytes = MAX_LOG_BYTES) {
  let stream: WriteStream | null = null;
  let written = 0;

  const open = (): void => {
    written = existsSync(path) ? statSync(path).size : 0;
    // 上次没轮转完就超了(比如进程被强杀):这次先轮转
    if (written >= maxBytes) rotate();
    stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  };
  const rotate = (): void => {
    try { stream?.end(); } catch { /* 已经关了 */ }
    stream = null;
    const prev = path.replace(/\.log$/, '.prev.log');
    try { if (existsSync(path)) { if (existsSync(prev)) renameSync(prev, prev + '.tmp'); renameSync(path, prev); } } catch { /* 占用时下一轮再试 */ }
    written = 0;
  };

  open();

  return {
    write(chunk: string): void {
      // 写流自己排队;盘跟不上时 Node 会缓冲,不再阻塞主进程
      if (!stream) open();
      stream?.write(chunk);
      written += Buffer.byteLength(chunk);
      if (written >= maxBytes) rotate();
    },
    get size(): number { return written; },
    close(): void { try { stream?.end(); } catch { /* 已关 */ } stream = null; },
  };
}

export type LogFile = ReturnType<typeof createLogFile>;
export const logFiles = { name: (dir: string, file: string) => join(dir, file) };

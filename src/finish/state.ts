/** Локальное состояние finish по сессиям: номер последнего сегмента, watermark, блокировка. */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface SessionState {
  seq: number;
  watermark: unknown;
}

/** Дольше этого finish не идёт: выжимка ограничена таймаутом */
const STALE_LOCK_MS = 30 * 60_000;

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export class FinishState {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(agent: string, sessionId: string, ext: string): string {
    return join(this.dir, `${safe(agent)}__${safe(sessionId)}.${ext}`);
  }

  load(agent: string, sessionId: string): SessionState | null {
    const path = this.path(agent, sessionId, 'json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SessionState) : null;
  }

  save(agent: string, sessionId: string, state: SessionState): void {
    const path = this.path(agent, sessionId, 'json');
    writeFileSync(`${path}.tmp`, JSON.stringify(state));
    renameSync(`${path}.tmp`, path);
  }

  /**
   * Эксклюзивная блокировка сессии; null — уже идёт другой finish. Возвращает функцию снятия.
   * Блокировка старше STALE_LOCK_MS считается оставшейся от упавшего процесса и перехватывается.
   */
  lock(agent: string, sessionId: string): (() => void) | null {
    const path = this.path(agent, sessionId, 'lock');
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) rmSync(path, { force: true });
    try {
      closeSync(openSync(path, 'wx'));
    } catch {
      return null;
    }
    return () => rmSync(path, { force: true });
  }
}

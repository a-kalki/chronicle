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
  /** Итоги уже отправленных сегментов — чтобы выжимка продолжения не повторяла их */
  summaries?: string[];
  /** Номер последнего отправленного хода: нумерация ходов сквозная по сегментам */
  turns?: number;
}

/** Сколько недавних фокусов помнить на проект */
const FOCUSES_KEPT = 10;

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

  /** Недавние фокусы проекта (по всем сессиям на машине) — выжимка переиспользует подходящие */
  recentFocuses(project: string): string[] {
    return this.focuses()[project] ?? [];
  }

  rememberFocuses(byProject: Record<string, string[]>): void {
    const all = this.focuses();
    for (const [project, focuses] of Object.entries(byProject)) {
      const merged = [...focuses.toReversed(), ...(all[project] ?? [])];
      all[project] = [...new Set(merged)].slice(0, FOCUSES_KEPT);
    }
    const path = join(this.dir, '_focuses.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(all));
    renameSync(`${path}.tmp`, path);
  }

  private focuses(): Record<string, string[]> {
    const path = join(this.dir, '_focuses.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>) : {};
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

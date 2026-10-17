/**
 * Последний итог finish по каждому агенту — чтобы фоновый результат был виден пользователю:
 * уведомление в pi, строка статуса в Claude Code. Файл: <stateDir>/last-finish.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LastFinish {
  agent: string;
  sessionId: string;
  status: 'running' | 'reported' | 'skipped' | 'failed';
  /** Время записи статуса */
  at: string;
  summary?: string;
  /** Сколько кандидатов в знания отправлено */
  knowledge?: number;
  reason?: string;
}

const FILE = 'last-finish.json';
/** Итог старше этого в строке статуса уже не интересен */
const STALE_MS = 12 * 3_600_000;

export function readLastFinish(stateDir: string): Record<string, LastFinish> {
  const path = join(stateDir, FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, LastFinish>;
  } catch {
    return {};
  }
}

export function writeLastFinish(stateDir: string, entry: LastFinish): void {
  mkdirSync(stateDir, { recursive: true });
  const all = { ...readLastFinish(stateDir), [entry.agent]: entry };
  const path = join(stateDir, FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(all, null, 2));
  renameSync(`${path}.tmp`, path);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);

export function formatStatusLine(o: {
  last: LastFinish | undefined;
  pending: number;
  now: Date;
  model?: string;
  timeZone?: string;
}): string {
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: o.timeZone });

  const parts: string[] = [];
  const { last } = o;
  if (last && o.now.getTime() - Date.parse(last.at) < STALE_MS) {
    if (last.status === 'running') parts.push('⏳ итог сессии…');
    else if (last.status === 'failed') parts.push(`✖ ${time(last.at)} ошибка — finish.log`);
    else if (last.status === 'skipped') parts.push(`· ${time(last.at)} пропуск: ${last.reason ?? ''}`.trimEnd());
    else {
      const knowledge = last.knowledge ? ` +${last.knowledge}` : '';
      parts.push(`✓ ${time(last.at)} «${clip(last.summary ?? '', 30)}»${knowledge}`);
    }
  }
  if (o.pending > 0) parts.push(`⇡${o.pending} в очереди`);

  const chronicle = parts.length > 0 ? `chronicle ${parts.join(' ')}` : '';
  return [o.model, chronicle].filter(Boolean).join(' · ');
}

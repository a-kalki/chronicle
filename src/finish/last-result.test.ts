import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStatusLine, type LastFinish, readLastFinish, writeLastFinish } from './last-result.ts';

const now = new Date('2026-10-17T12:40:00.000Z');
const base: LastFinish = { agent: 'claude-code', sessionId: 's-1', status: 'reported', at: '2026-10-17T12:39:00.000Z' };

describe('last-finish.json', () => {
  it('хранит последний итог по каждому агенту отдельно', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-last-'));
    writeLastFinish(dir, { ...base, status: 'running' });
    writeLastFinish(dir, { ...base, agent: 'pi', sessionId: 'p-1', status: 'failed', reason: 'boom' });
    writeLastFinish(dir, { ...base, summary: 'Сделан CLI', knowledge: 2 });
    const all = readLastFinish(dir);
    expect(all['claude-code']).toMatchObject({ status: 'reported', summary: 'Сделан CLI', knowledge: 2 });
    expect(all.pi).toMatchObject({ status: 'failed', reason: 'boom' });
  });

  it('нет файла — пустой объект', () => {
    expect(readLastFinish(mkdtempSync(join(tmpdir(), 'chronicle-last-')))).toEqual({});
  });
});

describe('formatStatusLine', () => {
  const line = (last: LastFinish | undefined, pending = 0, model?: string) =>
    formatStatusLine({ last, pending, now, model, timeZone: 'UTC' });

  it('успех: время, начало итога, число знаний', () => {
    expect(line({ ...base, summary: 'Спроектирован сервис chronicle и его контракт', knowledge: 2 })).toBe(
      'chronicle ✓ 12:39 «Спроектирован сервис chronicle…» +2',
    );
  });

  it('в процессе, ошибка, пропуск', () => {
    expect(line({ ...base, status: 'running' })).toBe('chronicle ⏳ итог сессии…');
    expect(line({ ...base, status: 'failed', reason: 'x' })).toBe('chronicle ✖ 12:39 ошибка — finish.log');
    expect(line({ ...base, status: 'skipped', reason: 'тривиальный сегмент' })).toBe(
      'chronicle · 12:39 пропуск: тривиальный сегмент',
    );
  });

  it('модель впереди, очередь в конце; старый итог не показывается', () => {
    expect(line({ ...base, at: '2026-10-16T20:00:00.000Z' }, 3, 'Opus 5.5')).toBe('Opus 5.5 · chronicle ⇡3 в очереди');
    expect(line(undefined, 0, 'Opus 5.5')).toBe('Opus 5.5');
  });
});

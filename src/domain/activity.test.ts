import { describe, expect, it } from 'bun:test';
import { activeMs } from './activity.ts';

const MIN = 60_000;
const at = (m: number) => new Date(Date.UTC(2026, 9, 17, 5, m)).toISOString();

describe('activeMs', () => {
  it('суммирует промежутки между событиями не длиннее порога простоя', () => {
    const segment = {
      startedAt: at(0),
      endedAt: at(100),
      source: 'log' as const,
      events: [at(0), at(10), at(20), at(80), at(100)].map((t) => ({ at: t })),
    };
    // 0→10, 10→20, 80→100 учитываются; 20→80 (60 мин) — простой
    expect(activeMs(segment, 30 * MIN)).toBe(40 * MIN);
  });

  it('порог применяется при чтении: другой порог — другой результат', () => {
    const segment = {
      startedAt: at(0),
      endedAt: at(60),
      source: 'log' as const,
      events: [at(0), at(60)].map((t) => ({ at: t })),
    };
    expect(activeMs(segment, 30 * MIN)).toBe(0);
    expect(activeMs(segment, 90 * MIN)).toBe(60 * MIN);
  });

  it('не зависит от порядка событий', () => {
    const segment = {
      startedAt: at(0),
      endedAt: at(20),
      source: 'log' as const,
      events: [at(20), at(0), at(10)].map((t) => ({ at: t })),
    };
    expect(activeMs(segment, 30 * MIN)).toBe(20 * MIN);
  });

  it('для coarse-активности возвращает весь интервал сегмента', () => {
    const segment = { startedAt: at(0), endedAt: at(45), source: 'coarse' as const, events: [] };
    expect(activeMs(segment, 30 * MIN)).toBe(45 * MIN);
  });
});

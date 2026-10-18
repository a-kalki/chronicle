import { describe, expect, it } from 'bun:test';
import { activeIntervals, activeMs, parallelMs, splitAt, unionMs } from './activity.ts';

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

describe('activeIntervals', () => {
  it('склеивает соседние промежутки не длиннее порога, простой разрывает интервал', () => {
    const segment = {
      startedAt: at(0),
      endedAt: at(100),
      source: 'log' as const,
      events: [at(10), at(0), at(20), at(80), at(100)].map((t) => ({ at: t })),
    };
    expect(activeIntervals(segment, 30 * MIN)).toEqual([
      { start: Date.parse(at(0)), end: Date.parse(at(20)) },
      { start: Date.parse(at(80)), end: Date.parse(at(100)) },
    ]);
  });

  it('coarse — весь интервал сегмента', () => {
    const segment = { startedAt: at(0), endedAt: at(50), source: 'coarse' as const, events: [] };
    expect(activeIntervals(segment, 30 * MIN)).toEqual([{ start: Date.parse(at(0)), end: Date.parse(at(50)) }]);
  });
});

describe('интервалы', () => {
  const iv = (a: number, b: number) => ({ start: a * MIN, end: b * MIN });

  it('unionMs — длина объединения: пересечения не считаются дважды', () => {
    expect(unionMs([iv(0, 10), iv(5, 20), iv(30, 40)])).toBe(30 * MIN);
    expect(unionMs([])).toBe(0);
  });

  it('parallelMs — участки, где активны две и более сессии', () => {
    const a = [iv(0, 30)];
    const b = [iv(10, 20), iv(25, 50)];
    const c = [iv(15, 16)];
    // 10→20 и 25→30 — пересечение a и b; c внутри уже параллельного участка
    expect(parallelMs([a, b, c])).toBe(15 * MIN);
  });

  it('parallelMs — интервалы одной сессии параллельности не дают', () => {
    expect(parallelMs([[iv(0, 10), iv(5, 15)]])).toBe(0);
  });

  it('splitAt — режет интервалы по границам ходов', () => {
    expect(splitAt([iv(0, 30), iv(40, 50)], [10 * MIN, 45 * MIN])).toEqual([
      iv(0, 10),
      iv(10, 30),
      iv(40, 45),
      iv(45, 50),
    ]);
  });
});

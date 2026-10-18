import { describe, expect, it } from 'bun:test';
import { dayBounds, localDate, localTime } from './day.ts';

describe('день в часовом поясе', () => {
  it('границы локальных суток в UTC', () => {
    expect(dayBounds('2026-10-17', 'Asia/Oral')).toEqual({
      from: '2026-10-16T19:00:00.000Z',
      to: '2026-10-17T19:00:00.000Z',
    });
    // переход на зимнее время: сутки длиной 25 часов
    expect(dayBounds('2026-10-25', 'Europe/Berlin')).toEqual({
      from: '2026-10-24T22:00:00.000Z',
      to: '2026-10-25T23:00:00.000Z',
    });
  });

  it('локальная дата и время момента', () => {
    expect(localDate('2026-10-17T19:30:00.000Z', 'Asia/Oral')).toBe('2026-10-18');
    expect(localTime(Date.parse('2026-10-17T04:05:00.000Z'), 'Asia/Oral')).toBe('09:05');
  });
});

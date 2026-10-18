import { describe, expect, it } from 'bun:test';
import { dayReport, formatDayReport } from './day-report.ts';
import type { Facts } from './facts.ts';
import type { StoredSegment } from './store.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
// сутки 2026-10-17 в Asia/Oral: с 2026-10-16T19:00Z
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 17, h - 5, m)).toISOString();
/** События каждые 10 минут — непрерывная активность */
const events = (from: string, to: string) => {
  const out: StoredSegment['events'] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 10 * MIN) {
    out.push({ at: new Date(t).toISOString(), actor: 'agent' });
  }
  return out;
};

function segment(over: Partial<StoredSegment>): StoredSegment {
  return {
    id: 1,
    agent: 'claude-code',
    agentSessionId: 's-1',
    host: 'laptop',
    person: 'nur',
    cwd: '/school',
    launchProject: 'u7-school',
    seq: 1,
    startedAt: at(9),
    endedAt: at(12),
    activitySource: 'log',
    summary: 'x',
    superseded: false,
    events: events(at(9), at(12)),
    turns: [],
    outcomes: [],
    commits: [],
    files: [],
    ...over,
  };
}

const facts = (segments: StoredSegment[]): Facts => ({
  from: '2026-10-16T19:00:00.000Z',
  to: '2026-10-17T19:00:00.000Z',
  settings: { idleGapMinutes: 30, timezone: 'Asia/Oral' },
  projects: [
    { id: 'u7-school', name: 'u7-school' },
    { id: 'chronicle', name: 'chronicle' },
  ],
  segments,
});

describe('dayReport', () => {
  // 09:00–12:00: ход 1 — школа, с 10:00 ход 2 — chronicle
  const main = segment({
    turns: [
      { idx: 1, at: at(9), projectId: 'u7-school', focus: 'Расписание' },
      { idx: 2, at: at(10), projectId: 'chronicle', focus: 'Модель v2' },
      { idx: 3, at: at(11), projectId: 'chronicle', focus: 'Модель v2' },
    ],
    outcomes: [
      { projectId: 'u7-school', focus: 'Расписание', text: 'Расписание готово' },
      { projectId: 'chronicle', focus: 'Модель v2', text: 'Контракт v2' },
    ],
    commits: [
      { projectId: 'chronicle', hash: 'aaa', subject: 'feat: v2', at: at(10, 30) },
      { projectId: 'chronicle', hash: 'bbb', subject: 'fix: y', at: at(11, 50) },
    ],
  });

  it('время по проектам — по ходам; эпизоды — подряд идущие ходы с одним фокусом', () => {
    const r = dayReport(facts([main]), { day: '2026-10-17' });
    expect(r.totalMs).toBe(3 * HOUR);
    expect(r.parallelMs).toBe(0);
    expect(r.projects.map((p) => [p.name, p.ms])).toEqual([
      ['chronicle', 2 * HOUR],
      ['u7-school', HOUR],
    ]);
    const chronicle = r.projects[0];
    expect(chronicle?.episodes).toHaveLength(1);
    expect(chronicle?.episodes[0]).toMatchObject({
      focus: 'Модель v2',
      ms: 2 * HOUR,
      outcomes: ['Контракт v2'],
      commits: [
        { hash: 'aaa', subject: 'feat: v2', at: at(10, 30) },
        { hash: 'bbb', subject: 'fix: y', at: at(11, 50) },
      ],
    });
    expect(r.projects[1]?.episodes[0]?.outcomes).toEqual(['Расписание готово']);
  });

  it('параллельная сессия: время человека — объединение, параллельное — пересечение; коммит из двух сессий — один', () => {
    const parallel = segment({
      id: 2,
      agent: 'pi',
      agentSessionId: 'p-1',
      startedAt: at(11),
      endedAt: at(13),
      events: events(at(11), at(13)),
      turns: [{ idx: 1, at: at(11), projectId: 'u7-school', focus: 'Деплой' }],
      commits: [{ projectId: 'chronicle', hash: 'bbb', subject: 'fix: y', at: at(11, 50) }],
    });
    const r = dayReport(facts([main, parallel]), { day: '2026-10-17' });
    expect(r.totalMs).toBe(4 * HOUR);
    expect(r.parallelMs).toBe(HOUR);
    expect(r.projects.find((p) => p.name === 'u7-school')?.ms).toBe(3 * HOUR);
    expect(r.commits).toBe(2);
  });

  it('сегмент без ходов (v1) — один ход: весь интервал в проект запуска, фокус пуст', () => {
    const v1 = segment({
      activitySource: 'coarse',
      events: [],
      outcomes: [{ projectId: 'u7-school', focus: null, text: 'Сделано' }],
    });
    const r = dayReport(facts([v1]), { day: '2026-10-17' });
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]).toMatchObject({ name: 'u7-school', ms: 3 * HOUR });
    expect(r.projects[0]?.episodes[0]).toMatchObject({ focus: null, outcomes: ['Сделано'] });
  });

  it('активность вне дня обрезается', () => {
    const late = segment({ startedAt: at(18), endedAt: at(26), events: events(at(18), at(26)), turns: [] });
    expect(dayReport(facts([late]), { day: '2026-10-17' }).totalMs).toBe(6 * HOUR);
  });

  it('формат: часы с параллельным временем, эпизоды с результатами и коммитами', () => {
    const text = formatDayReport(dayReport(facts([main]), { day: '2026-10-17' }), 'Asia/Oral');
    expect(text).toContain('2026-10-17 — 3.0 ч');
    expect(text).toContain('chronicle — 2.0 ч');
    expect(text).toContain('10:00–12:00 Модель v2 — 2.0 ч');
    expect(text).toContain('• Контракт v2');
    expect(text).toContain('aaa feat: v2');
  });
});

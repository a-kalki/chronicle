import { describe, expect, it } from 'bun:test';
import * as v from 'valibot';
import { extractResultJsonSchema } from './json-schema.ts';
import { ExtractResult, SessionReport } from './v2.ts';

const report = {
  version: 2,
  session: {
    agent: 'claude-code',
    id: '4e6bfd2b',
    host: 'laptop',
    seq: 1,
    startedAt: '2026-10-17T05:00:00.000Z',
    endedAt: '2026-10-17T07:00:00.000Z',
  },
  launch: { cwd: '/home/nur/dev/kalki/u7-school', projectKey: 'p1' },
  projects: [
    { key: 'p1', remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: '/home/nur/dev/kalki/u7-school' },
    { key: 'p2', remote: 'github.com/a-kalki/chronicle', name: 'chronicle', path: '/home/nur/dev/tools/chronicle' },
  ],
  activity: {
    source: 'log',
    events: [
      { at: '2026-10-17T05:00:00.000Z', actor: 'user' },
      { at: '2026-10-17T06:00:00.000Z', actor: 'user' },
      { at: '2026-10-17T07:00:00.000Z', actor: 'agent' },
    ],
  },
  turns: [
    { idx: 1, at: '2026-10-17T05:00:00.000Z', projectKey: 'p1', focus: 'Расписание' },
    { idx: 2, at: '2026-10-17T06:00:00.000Z', projectKey: 'p2', focus: null },
  ],
  work: {
    summary: 'Сделано расписание и правка chronicle',
    outcomes: [{ projectKey: 'p1', focus: 'Расписание', text: 'Добавлено расписание' }],
    commits: [{ projectKey: 'p2', hash: 'a979b2f', subject: 'fix: x', at: '2026-10-17T06:30:00.000Z' }],
    files: [{ projectKey: 'p2', path: 'src/x.ts' }],
  },
  knowledge: [],
  usage: [],
};

const ok = (r: unknown) => v.safeParse(SessionReport, r).success;

describe('SessionReport v2', () => {
  it('принимает отчёт с ходами в разных проектах', () => {
    expect(ok(report)).toBe(true);
  });

  it('принимает replace, запуск вне git и ход без проекта', () => {
    expect(
      ok({
        ...report,
        replace: true,
        launch: { cwd: '/tmp', projectKey: null },
        turns: [{ idx: 1, at: '2026-10-17T05:00:00.000Z', projectKey: null, focus: null }],
      }),
    ).toBe(true);
  });

  it('отклоняет ссылку на неизвестный проект', () => {
    expect(ok({ ...report, launch: { cwd: '/x', projectKey: 'p9' } })).toBe(false);
    expect(ok({ ...report, turns: [{ ...report.turns[0], projectKey: 'p9' }] })).toBe(false);
    expect(
      ok({ ...report, work: { ...report.work, commits: [{ ...report.work.commits[0], projectKey: 'p9' }] } }),
    ).toBe(false);
    expect(ok({ ...report, work: { ...report.work, files: [{ projectKey: 'p9', path: 'a' }] } })).toBe(false);
    expect(ok({ ...report, work: { ...report.work, outcomes: [{ projectKey: 'p9', focus: null, text: 'x' }] } })).toBe(
      false,
    );
  });

  it('отклоняет повтор ключа проекта', () => {
    expect(ok({ ...report, projects: [report.projects[0], { ...report.projects[1], key: 'p1' }] })).toBe(false);
  });

  it('отклоняет ходы не по возрастанию номера и вне интервала сегмента', () => {
    expect(ok({ ...report, turns: [report.turns[1], report.turns[0]] })).toBe(false);
    expect(ok({ ...report, turns: [{ ...report.turns[0], at: '2026-10-17T08:00:00.000Z' }] })).toBe(false);
  });

  it('проверяет интервал и активность как v1', () => {
    expect(ok({ ...report, session: { ...report.session, endedAt: '2026-10-17T04:00:00.000Z' } })).toBe(false);
    expect(ok({ ...report, activity: { source: 'coarse', events: report.activity.events } })).toBe(false);
  });

  it('отклоняет v1', () => {
    expect(ok({ ...report, version: 1 })).toBe(false);
  });
});

describe('ExtractResult v2', () => {
  const extract = {
    work: {
      summary: 'Сделано',
      episodes: [{ from: 1, to: 2, focus: 'Расписание', items: ['Добавлено расписание'] }],
    },
    knowledge: [],
    usage: [],
  };

  it('принимает выжимку с эпизодами', () => {
    expect(v.safeParse(ExtractResult, extract).success).toBe(true);
  });

  it('отклоняет фокус длиннее 60 символов и номер хода меньше 1', () => {
    const long = { ...extract.work.episodes[0], focus: 'x'.repeat(61) };
    expect(v.safeParse(ExtractResult, { ...extract, work: { ...extract.work, episodes: [long] } }).success).toBe(false);
    const zero = { ...extract.work.episodes[0], from: 0 };
    expect(v.safeParse(ExtractResult, { ...extract, work: { ...extract.work, episodes: [zero] } }).success).toBe(false);
  });
});

describe('JSON Schema выжимки', () => {
  it('генерируется из valibot-схемы v2 и описывает эпизоды', () => {
    const schema = extractResultJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required.sort()).toEqual(['knowledge', 'usage', 'work']);
    expect(JSON.stringify(schema.properties.work)).toContain('"episodes"');
    expect(JSON.stringify(schema.properties.knowledge)).toContain('"trap"');
  });
});

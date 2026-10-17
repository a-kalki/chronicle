import { describe, expect, it } from 'bun:test';
import * as v from 'valibot';
import { extractResultJsonSchema } from './json-schema.ts';
import { ExtractResult, SessionReport } from './v1.ts';

const candidate = {
  scope: 'project',
  kind: 'trap',
  title: 'Biome схлопывает массивы, которые разворачивает JSON.stringify',
  symptoms: ['Formatter would have printed the following content'],
  cause: 'JSON.stringify(value, null, 2) всегда разворачивает массивы',
  fix: 'После записи JSON прогонять bunx biome format --write',
  tags: ['biome', 'json'],
};

const report = {
  version: 1,
  session: {
    agent: 'claude-code',
    id: '4e6bfd2b-1d67-4903-93fb-96d9e3c8a4e9',
    host: 'laptop',
    seq: 1,
    startedAt: '2026-10-17T05:00:00.000Z',
    endedAt: '2026-10-17T06:30:00.000Z',
  },
  project: { remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: '/home/nur/dev/kalki/u7-school' },
  activity: {
    source: 'log',
    events: [
      { at: '2026-10-17T05:00:00.000Z', actor: 'user' },
      { at: '2026-10-17T06:30:00.000Z', actor: 'agent' },
    ],
  },
  work: {
    summary: 'Спроектирован сервис chronicle',
    items: ['Написана спецификация'],
    commits: [{ hash: 'a979b2f', subject: 'docs: спецификация', at: '2026-10-17T06:20:00.000Z' }],
    files: ['docs/spec.md'],
  },
  knowledge: [candidate],
  usage: [{ entryId: 'R-biome-json-stringify-expand', helped: true }],
};

describe('SessionReport v1', () => {
  it('принимает корректный отчёт', () => {
    expect(v.safeParse(SessionReport, report).success).toBe(true);
  });

  it('принимает отчёт без remote и с грубой активностью без событий', () => {
    const coarse = {
      ...report,
      project: { name: 'notes', path: '/home/nur/notes' },
      activity: { source: 'coarse', events: [] },
    };
    expect(v.safeParse(SessionReport, coarse).success).toBe(true);
  });

  it('отклоняет неизвестную версию контракта', () => {
    expect(v.safeParse(SessionReport, { ...report, version: 2 }).success).toBe(false);
  });

  it('отклоняет конец сегмента раньше начала', () => {
    const bad = { ...report, session: { ...report.session, endedAt: '2026-10-17T04:00:00.000Z' } };
    expect(v.safeParse(SessionReport, bad).success).toBe(false);
  });

  it('отклоняет события активности вне интервала сегмента', () => {
    const bad = {
      ...report,
      activity: { source: 'log', events: [{ at: '2026-10-17T07:00:00.000Z', actor: 'user' }] },
    };
    expect(v.safeParse(SessionReport, bad).success).toBe(false);
  });

  it('отклоняет события при грубой активности', () => {
    const bad = { ...report, activity: { source: 'coarse', events: report.activity.events } };
    expect(v.safeParse(SessionReport, bad).success).toBe(false);
  });

  it('отклоняет имя агента не в формате slug', () => {
    const bad = { ...report, session: { ...report.session, agent: 'Claude Code' } };
    expect(v.safeParse(SessionReport, bad).success).toBe(false);
  });

  it('отклоняет дату без зоны', () => {
    const bad = { ...report, session: { ...report.session, startedAt: '2026-10-17T05:00' } };
    expect(v.safeParse(SessionReport, bad).success).toBe(false);
  });
});

describe('ExtractResult v1', () => {
  const extract = { work: { summary: 'Сделано', items: [] }, knowledge: [candidate], usage: [] };

  it('принимает выжимку агента', () => {
    expect(v.safeParse(ExtractResult, extract).success).toBe(true);
  });

  it('отклоняет вид знания вне trap/fact', () => {
    const bad = { ...extract, knowledge: [{ ...candidate, kind: 'practice' }] };
    expect(v.safeParse(ExtractResult, bad).success).toBe(false);
  });

  it('отклоняет пустой итог', () => {
    expect(v.safeParse(ExtractResult, { ...extract, work: { summary: '', items: [] } }).success).toBe(false);
  });
});

describe('JSON Schema выжимки', () => {
  it('генерируется из valibot-схемы и описывает обязательные поля', () => {
    const schema = extractResultJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required.sort()).toEqual(['knowledge', 'usage', 'work']);
    expect(JSON.stringify(schema.properties.knowledge)).toContain('"trap"');
  });
});

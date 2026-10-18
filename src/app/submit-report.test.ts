import { beforeEach, describe, expect, it } from 'bun:test';
import type { SessionReport } from '../../contract/v1.ts';
import { openStore, type SqliteStore } from '../infra/sqlite-store.ts';
import { submitReport } from './submit-report.ts';

function makeReport(over: Partial<SessionReport> = {}): unknown {
  return {
    version: 1,
    session: {
      agent: 'claude-code',
      id: 's-1',
      host: 'laptop',
      seq: 1,
      startedAt: '2026-10-17T05:00:00.000Z',
      endedAt: '2026-10-17T06:00:00.000Z',
    },
    project: { remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: '/home/nur/dev/kalki/u7-school' },
    activity: {
      source: 'log',
      events: [
        { at: '2026-10-17T05:00:00.000Z', actor: 'user' },
        { at: '2026-10-17T05:10:00.000Z', actor: 'agent' },
      ],
    },
    work: {
      summary: 'Сделан контракт',
      items: ['Схемы', 'Тесты'],
      commits: [{ hash: 'efb9fb6', subject: 'feat(contract): v1', at: '2026-10-17T05:50:00.000Z' }],
      files: ['contract/v1.ts'],
    },
    knowledge: [
      {
        scope: 'project',
        kind: 'trap',
        title: 'trim не конвертируется в JSON Schema',
        symptoms: ['The "trim" action cannot be converted to JSON Schema.'],
        cause: 'trim — преобразование',
        fix: 'ignoreActions: ["trim"]',
        tags: ['valibot'],
      },
    ],
    usage: [],
    ...over,
  };
}

describe('submitReport', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('сохраняет сегмент, проект и кандидатов в знания', () => {
    const res = submitReport(store, makeReport());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.duplicate).toBe(false);
    expect(res.candidates).toBe(1);

    const seg = store.getSegment(res.segmentId);
    expect(seg?.launchProject).toBe('u7-school');
    expect(seg?.summary).toBe('Сделан контракт');
    expect(seg?.events).toHaveLength(2);
    expect(seg?.commits[0]).toMatchObject({ hash: 'efb9fb6', projectId: 'u7-school' });
    expect(seg?.outcomes).toEqual([
      { projectId: 'u7-school', focus: null, text: 'Схемы' },
      { projectId: 'u7-school', focus: null, text: 'Тесты' },
    ]);
    expect(seg?.turns).toEqual([]);
    expect(store.pendingCandidates()).toHaveLength(1);
  });

  it('повторная отправка того же сегмента ничего не меняет', () => {
    const first = submitReport(store, makeReport());
    const second = submitReport(store, makeReport());
    expect(second).toEqual({
      ok: true,
      duplicate: true,
      segmentId: first.ok ? first.segmentId : -1,
      candidates: 0,
      unknownEntries: [],
    });
    expect(store.pendingCandidates()).toHaveLength(1);
  });

  it('узнаёт проект по remote с другой машины и другого пути', () => {
    const a = submitReport(store, makeReport());
    const b = submitReport(
      store,
      makeReport({
        session: {
          agent: 'pi',
          id: 's-2',
          host: 'kalki-server',
          seq: 1,
          startedAt: '2026-10-17T07:00:00.000Z',
          endedAt: '2026-10-17T07:30:00.000Z',
        },
        project: { remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: '/srv/u7-school' },
        activity: { source: 'coarse', events: [] },
      }),
    );
    if (!a.ok || !b.ok) throw new Error('ожидался успех');
    expect(store.getSegment(b.segmentId)?.launchProject).toBe(store.getSegment(a.segmentId)?.launchProject);
  });

  it('без remote узнаёт проект по host и пути, разные проекты с одним именем не склеивает', () => {
    const noRemote = (host: string, path: string, id: string) =>
      makeReport({
        session: {
          agent: 'claude-code',
          id,
          host,
          seq: 1,
          startedAt: '2026-10-17T05:00:00.000Z',
          endedAt: '2026-10-17T06:00:00.000Z',
        },
        project: { name: 'notes', path },
      });
    const a = submitReport(store, noRemote('laptop', '/home/nur/notes', 'n-1'));
    const b = submitReport(store, noRemote('laptop', '/home/nur/notes', 'n-2'));
    const c = submitReport(store, noRemote('kalki-server', '/home/nur/notes', 'n-3'));
    if (!a.ok || !b.ok || !c.ok) throw new Error('ожидался успех');
    expect(store.getSegment(b.segmentId)?.launchProject).toBe('notes');
    expect(store.getSegment(a.segmentId)?.launchProject).toBe('notes');
    expect(store.getSegment(c.segmentId)?.launchProject).toBe('notes-2');
  });

  it('следующий сегмент той же сессии сохраняется отдельно', () => {
    submitReport(store, makeReport());
    const next = submitReport(
      store,
      makeReport({
        session: {
          agent: 'claude-code',
          id: 's-1',
          host: 'laptop',
          seq: 2,
          startedAt: '2026-10-17T08:00:00.000Z',
          endedAt: '2026-10-17T08:30:00.000Z',
        },
        activity: { source: 'coarse', events: [] },
      }),
    );
    expect(next.ok && !next.duplicate).toBe(true);
  });

  it('отклоняет отчёт, нарушающий контракт, с описанием ошибок', () => {
    const res = submitReport(store, { ...(makeReport() as object), version: 9 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.length).toBeGreaterThan(0);
  });

  it('учитывает пользу только существующих записей, неизвестные ID возвращает', () => {
    const res = submitReport(store, makeReport({ usage: [{ entryId: 'R-unknown', helped: true }] }));
    expect(res.ok && res.unknownEntries).toEqual(['R-unknown']);
  });
});

const v2 = {
  version: 2,
  session: {
    agent: 'claude-code',
    id: 's-v2',
    host: 'laptop',
    seq: 1,
    startedAt: '2026-10-17T05:00:00.000Z',
    endedAt: '2026-10-17T07:00:00.000Z',
  },
  launch: { cwd: '/school', projectKey: 'school' },
  projects: [
    { key: 'school', remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: '/school' },
    { key: 'chr', remote: 'github.com/a-kalki/chronicle', name: 'chronicle', path: '/chronicle' },
  ],
  activity: {
    source: 'log',
    events: [
      { at: '2026-10-17T05:00:00.000Z', actor: 'user' },
      { at: '2026-10-17T07:00:00.000Z', actor: 'agent' },
    ],
  },
  turns: [
    { idx: 1, at: '2026-10-17T05:00:00.000Z', projectKey: 'school', focus: 'Расписание' },
    { idx: 2, at: '2026-10-17T05:30:00.000Z', projectKey: 'chr', focus: 'Модель v2' },
    { idx: 3, at: '2026-10-17T06:00:00.000Z', projectKey: 'chr', focus: 'Модель v2' },
  ],
  work: {
    summary: 'Модель v2',
    outcomes: [{ projectKey: 'chr', focus: 'Модель v2', text: 'Контракт v2' }],
    commits: [{ projectKey: 'chr', hash: 'dc8b591', subject: 'feat(contract): v2', at: '2026-10-17T06:30:00.000Z' }],
    files: [{ projectKey: 'chr', path: 'contract/v2.ts' }],
  },
  knowledge: [
    {
      scope: 'project',
      kind: 'trap',
      title: 'rawCheck вместо check',
      symptoms: ['No overload matches this call.'],
      cause: 'тип check выводится из аргумента',
      fix: 'явный параметр типа',
      tags: ['valibot'],
    },
  ],
  usage: [],
};

describe('submitReport v2', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('сохраняет ходы, результаты, коммиты и файлы со своими проектами, сессию — с человеком', () => {
    const res = submitReport(store, v2, 'nur');
    if (!res.ok) throw new Error(res.issues.join('; '));
    const seg = store.getSegment(res.segmentId);
    expect(seg?.person).toBe('nur');
    expect(seg?.launchProject).toBe('u7-school');
    expect(seg?.turns.map((t) => [t.idx, t.projectId, t.focus])).toEqual([
      [1, 'u7-school', 'Расписание'],
      [2, 'chronicle', 'Модель v2'],
      [3, 'chronicle', 'Модель v2'],
    ]);
    expect(seg?.outcomes).toEqual([{ projectId: 'chronicle', focus: 'Модель v2', text: 'Контракт v2' }]);
    expect(seg?.commits[0]?.projectId).toBe('chronicle');
    expect(seg?.files).toEqual([{ projectId: 'chronicle', path: 'contract/v2.ts' }]);
  });

  it('кандидат scope project относится к основному проекту сегмента (больше ходов)', () => {
    submitReport(store, v2, 'nur');
    expect(store.pendingCandidates()[0]?.projectId).toBe('chronicle');
  });

  it('запуск вне git и ходы без проекта — без проекта', () => {
    const res = submitReport(
      store,
      {
        ...v2,
        launch: { cwd: '/tmp', projectKey: null },
        projects: [],
        turns: [{ idx: 1, at: '2026-10-17T05:00:00.000Z', projectKey: null, focus: null }],
        work: { summary: 'Разговор', outcomes: [], commits: [], files: [] },
      },
      'nur',
    );
    if (!res.ok) throw new Error(res.issues.join('; '));
    expect(store.getSegment(res.segmentId)?.launchProject).toBeNull();
    expect(store.pendingCandidates()[0]?.projectId).toBeNull();
  });

  it('replace помечает прежние сегменты сессии superseded и пишет новый; повтор replace — дубль', () => {
    const first = submitReport(store, v2, 'nur');
    const second = submitReport(store, { ...v2, session: { ...v2.session, seq: 2 } }, 'nur');
    const replay = { ...v2, replace: true, session: { ...v2.session, seq: 3 }, knowledge: [] };
    const third = submitReport(store, replay, 'nur');
    if (!first.ok || !second.ok || !third.ok) throw new Error('ожидался успех');
    expect(store.getSegment(first.segmentId)?.superseded).toBe(true);
    expect(store.getSegment(second.segmentId)?.superseded).toBe(true);
    expect(store.getSegment(third.segmentId)?.superseded).toBe(false);
    // кандидаты знаний прежних сегментов остаются
    expect(store.pendingCandidates()).toHaveLength(2);

    const again = submitReport(store, replay, 'nur');
    expect(again.ok && again.duplicate).toBe(true);
    expect(store.getSegment(third.segmentId)?.superseded).toBe(false);
  });
});

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
    expect(seg?.projectId).toBe('u7-school');
    expect(seg?.summary).toBe('Сделан контракт');
    expect(seg?.events).toHaveLength(2);
    expect(seg?.commits[0]?.hash).toBe('efb9fb6');
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
    expect(store.getSegment(b.segmentId)?.projectId).toBe(store.getSegment(a.segmentId)?.projectId);
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
    expect(store.getSegment(b.segmentId)?.projectId).toBe('notes');
    expect(store.getSegment(a.segmentId)?.projectId).toBe('notes');
    expect(store.getSegment(c.segmentId)?.projectId).toBe('notes-2');
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
    const res = submitReport(store, { ...(makeReport() as object), version: 2 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.length).toBeGreaterThan(0);
  });

  it('учитывает пользу только существующих записей, неизвестные ID возвращает', () => {
    const res = submitReport(store, makeReport({ usage: [{ entryId: 'R-unknown', helped: true }] }));
    expect(res.ok && res.unknownEntries).toEqual(['R-unknown']);
  });
});

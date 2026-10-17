import { beforeEach, describe, expect, it } from 'bun:test';
import { openStore, type SqliteStore } from '../infra/sqlite-store.ts';
import { archiveStale, curatePending } from './curate.ts';
import type { Llm } from './llm.ts';
import { submitReport } from './submit-report.ts';

const school = { remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: '/school' };

const candidate = {
  scope: 'project',
  kind: 'trap',
  title: 'Biome схлопывает массивы, которые разворачивает JSON.stringify',
  symptoms: ['Formatter would have printed the following content'],
  cause: 'JSON.stringify(value, null, 2) разворачивает массивы',
  fix: 'bunx biome format --write после записи JSON',
  tags: ['biome', 'json'],
};

function submit(store: SqliteStore, knowledge: unknown[], id = 's-1') {
  const res = submitReport(store, {
    version: 1,
    session: {
      agent: 'pi',
      id,
      host: 'laptop',
      seq: 1,
      startedAt: '2026-10-17T05:00:00.000Z',
      endedAt: '2026-10-17T06:00:00.000Z',
    },
    project: school,
    activity: { source: 'coarse', events: [] },
    work: { summary: 'Сделано', items: [], commits: [], files: [] },
    knowledge,
    usage: [],
  });
  if (!res.ok) throw new Error(res.issues.join('; '));
}

/** Фейковая LLM: отвечает заготовкой и запоминает, что ей показали. */
function fakeLlm(answer: (user: string) => unknown): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async completeJson(_system, user) {
      prompts.push(user);
      return answer(user);
    },
  };
}

describe('curatePending', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('create: заводит запись с историей, кандидат — created', async () => {
    submit(store, [candidate]);
    const llm = fakeLlm(() => ({ action: 'create', reason: 'новая ловушка', entry: candidate }));
    const res = await curatePending(store, llm);
    expect(res).toEqual({ created: 1, merged: 0, discarded: 0, failed: 0 });

    const [entry] = store.activeEntries('u7-school');
    expect(entry?.projectId).toBe('u7-school');
    expect(entry?.title).toBe(candidate.title);
    expect(store.entryHistory(entry?.id as string)[0]?.action).toBe('created');
    expect(store.pendingCandidates()).toEqual([]);
  });

  it('merge: обновляет существующую запись из числа показанных похожих', async () => {
    store.createProject({ ...school, host: 'laptop' });
    store.insertEntry({
      id: 'K-biome',
      projectId: 'u7-school',
      kind: 'trap',
      title: 'Biome и JSON.stringify',
      symptoms: [],
      cause: 'массивы',
      fix: 'biome format',
      tags: ['biome'],
    });
    submit(store, [candidate]);
    const llm = fakeLlm(() => ({
      action: 'merge',
      targetId: 'K-biome',
      reason: 'та же проблема',
      entry: { ...candidate, title: 'Biome схлопывает массивы JSON' },
    }));
    const res = await curatePending(store, llm);
    expect(res.merged).toBe(1);
    expect(llm.prompts[0]).toContain('K-biome');

    const entry = store.getEntry('K-biome');
    expect(entry?.title).toBe('Biome схлопывает массивы JSON');
    expect(entry?.symptoms).toEqual(candidate.symptoms);
    expect(store.entryHistory('K-biome').map((h) => h.action)).toEqual(['merged']);
  });

  it('discard: кандидат отброшен с причиной, записей нет', async () => {
    submit(store, [{ ...candidate, title: 'Тесты надо запускать' }]);
    const res = await curatePending(
      store,
      fakeLlm(() => ({ action: 'discard', reason: 'общеизвестно' })),
    );
    expect(res.discarded).toBe(1);
    expect(store.activeEntries('u7-school')).toEqual([]);
    expect(store.candidate(1)?.decisionNote).toBe('общеизвестно');
  });

  it('LLM может перевести знание в общий scope', async () => {
    submit(store, [candidate]);
    await curatePending(
      store,
      fakeLlm(() => ({ action: 'create', reason: 'про инструмент', entry: { ...candidate, scope: 'global' } })),
    );
    expect(store.activeEntries(null)[0]?.projectId).toBeNull();
  });

  it('merge в запись не из списка похожих — ошибка, кандидат остаётся pending', async () => {
    submit(store, [candidate]);
    const res = await curatePending(
      store,
      fakeLlm(() => ({ action: 'merge', targetId: 'K-ghost', reason: 'x', entry: candidate })),
    );
    expect(res.failed).toBe(1);
    expect(store.pendingCandidates()).toHaveLength(1);
    expect(store.candidate(1)?.lastError).toContain('K-ghost');
  });

  it('ответ не по схеме или сбой LLM — кандидат остаётся pending с ошибкой', async () => {
    submit(store, [candidate, { ...candidate, title: 'Другое' }]);
    let n = 0;
    const res = await curatePending(
      store,
      fakeLlm(() => {
        if (n++ === 0) return { action: 'create' };
        throw new Error('HTTP 503');
      }),
    );
    expect(res.failed).toBe(2);
    expect(store.pendingCandidates()).toHaveLength(2);
    expect(store.candidate(2)?.lastError).toContain('503');
  });
});

describe('archiveStale', () => {
  it('архивирует записи без использования дольше порога, свежие не трогает', () => {
    const store = openStore(':memory:');
    const base = { projectId: null, kind: 'trap' as const, symptoms: [], cause: 'c', fix: 'f', tags: [] };
    store.insertEntry({ ...base, id: 'K-old', title: 'старая' });
    store.insertEntry({ ...base, id: 'K-used', title: 'использованная' });
    store.insertUsage('K-used', null, true);

    const future = new Date(Date.now() + 200 * 86_400_000);
    store.insertUsage('K-used', null, true, future.toISOString());
    expect(archiveStale(store, 120, future)).toEqual(['K-old']);
    expect(store.getEntry('K-old')?.status).toBe('archived');
    expect(store.entryHistory('K-old')[0]?.action).toBe('archived');
    expect(store.getEntry('K-used')?.status).toBe('active');
  });
});

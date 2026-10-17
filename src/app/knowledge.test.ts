import { beforeEach, describe, expect, it } from 'bun:test';
import { openStore, type SqliteStore } from '../infra/sqlite-store.ts';
import { getEntry, recordUsage, searchKnowledge } from './knowledge.ts';
import type { NewEntry } from './store.ts';

const entry = (over: Partial<NewEntry>): NewEntry => ({
  id: 'K-1',
  projectId: null,
  kind: 'trap',
  title: 'Заголовок',
  symptoms: [],
  cause: 'причина',
  fix: 'решение',
  tags: [],
  ...over,
});

const school = { name: 'u7-school', host: 'laptop', path: '/school', remote: 'github.com/nurgeo/u7-school' };
const hub = { name: 'u7-hub', host: 'laptop', path: '/hub', remote: 'github.com/nurgeo/u7-hub' };

describe('знания: поиск, просмотр, польза', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = openStore(':memory:');
    store.createProject(school);
    store.createProject(hub);
    store.insertEntry(
      entry({
        id: 'K-biome',
        projectId: 'u7-school',
        title: 'Biome схлопывает массивы JSON',
        symptoms: ['Formatter would have printed the following content'],
        tags: ['biome', 'json'],
      }),
    );
    store.insertEntry(entry({ id: 'K-ssh', title: 'ssh-деплой: bun не найден', symptoms: ['bun: command not found'] }));
    store.insertEntry(
      entry({ id: 'K-hub', projectId: 'u7-hub', title: 'markdown-it экранирует фигурные скобки json' }),
    );
  });

  it('ищет в своём проекте и в общем, но не в чужом проекте', () => {
    const res = searchKnowledge(store, { q: 'json', project: school });
    expect(res.map((r) => r.id)).toEqual(['K-biome']);
  });

  it('находит по дословному тексту ошибки', () => {
    const res = searchKnowledge(store, { q: 'zsh: bun: command not found', project: school });
    expect(res[0]?.id).toBe('K-ssh');
  });

  it('без проекта (неизвестный путь) ищет только в общем', () => {
    const res = searchKnowledge(store, { q: 'json bun', project: { name: 'x', host: 'laptop', path: '/x' } });
    expect(res.map((r) => r.id)).toEqual(['K-ssh']);
  });

  it('не показывает архивные записи', () => {
    store.archiveEntry('K-biome');
    expect(searchKnowledge(store, { q: 'biome', project: school })).toEqual([]);
  });

  it('считает попадания в выдачу и открытия', () => {
    searchKnowledge(store, { q: 'biome', project: school });
    const e = getEntry(store, 'K-biome');
    expect(e?.found).toBe(1);
    expect(e?.opened).toBe(1);
  });

  it('записывает пользу и время последнего использования, неизвестную запись отклоняет', () => {
    expect(recordUsage(store, 'K-ssh', true)).toBe(true);
    expect(recordUsage(store, 'K-nope', true)).toBe(false);
    const e = getEntry(store, 'K-ssh');
    expect(e?.helped).toBe(1);
    expect(e?.lastUsedAt).not.toBeNull();
  });
});

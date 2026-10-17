import { beforeEach, describe, expect, it } from 'bun:test';
import { openStore, type SqliteStore } from '../infra/sqlite-store.ts';
import { importEntries } from './import-entries.ts';

const school = { name: 'u7-school', host: 'laptop', path: '/school', remote: 'github.com/nurgeo/u7-school' };

const item = {
  id: 'R-biome-json-stringify-expand',
  project: school,
  kind: 'trap',
  title: 'Biome схлопывает массивы JSON',
  symptoms: ['Formatter would have printed the following content'],
  cause: 'JSON.stringify разворачивает массивы',
  fix: 'bunx biome format --write',
  tags: ['biome'],
  note: 'pi-chronicle: problem',
  stats: { opened: 3, helped: 2 },
};

describe('importEntries', () => {
  let store: SqliteStore;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('заводит записи с исходным ID, проектом по remote, историей и статистикой', () => {
    const res = importEntries(store, { entries: [item, { ...item, id: 'R-global', project: null }] });
    expect(res).toEqual({ ok: true, imported: ['R-biome-json-stringify-expand', 'R-global'], skipped: [] });

    const e = store.getEntry('R-biome-json-stringify-expand');
    expect(e?.projectId).toBe('u7-school');
    expect(e?.opened).toBe(3);
    expect(e?.helped).toBe(2);
    expect(store.entryHistory(e?.id as string)).toMatchObject([{ action: 'imported', note: 'pi-chronicle: problem' }]);
    expect(store.getEntry('R-global')?.projectId).toBeNull();
  });

  it('повторный импорт пропускает существующие записи', () => {
    importEntries(store, { entries: [item] });
    expect(importEntries(store, { entries: [item] })).toEqual({
      ok: true,
      imported: [],
      skipped: ['R-biome-json-stringify-expand'],
    });
    expect(store.getEntry('R-biome-json-stringify-expand')?.helped).toBe(2);
  });

  it('нарушение схемы — ошибка, ничего не записано', () => {
    const res = importEntries(store, { entries: [item, { ...item, id: 'R-bad', kind: 'practice' }] });
    expect(res.ok).toBe(false);
    expect(store.getEntry('R-biome-json-stringify-expand')).toBeNull();
  });
});

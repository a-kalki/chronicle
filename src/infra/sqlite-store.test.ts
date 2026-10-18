import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from './migrations.ts';
import { openStore } from './sqlite-store.ts';

describe('openStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chronicle-store-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('повторное открытие не применяет миграции заново и сохраняет данные', () => {
    const path = join(dir, 'chronicle.db');
    const ref = { name: 'u7-school', host: 'laptop', path: '/p', remote: 'github.com/nurgeo/u7-school' };
    openStore(path).createProject(ref);

    const reopened = openStore(path);
    expect(reopened.matchProject(ref)).toBe('u7-school');
  });

  it('переход на v2 сохраняет данные v1: проект сессии становится проектом запуска', () => {
    const path = join(dir, 'v1.db');
    const db = new Database(path, { create: true });
    db.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    MIGRATIONS.slice(0, 2).forEach((sql, i) => {
      db.run(sql);
      db.run('INSERT INTO schema_migrations VALUES (?, ?)', [i + 1, 'x']);
    });
    db.run("INSERT INTO projects VALUES ('u7-school', 'u7-school', 'x')");
    db.run("INSERT INTO sessions VALUES (1, 'pi', 's-1', 'laptop', 'u7-school', '/school')");
    db.run(`INSERT INTO segments VALUES (1, 1, 1, '2026-10-17T05:00:00.000Z', '2026-10-17T06:00:00.000Z',
            'coarse', 'Сделано', 'x')`);
    db.run("INSERT INTO work_items VALUES (1, 0, 'Пункт')");
    db.run("INSERT INTO commits VALUES (1, 'abc', 'feat: x', '2026-10-17T05:30:00.000Z')");
    db.close();

    openStore(path);
    const after = new Database(path);
    expect(after.query('SELECT launch_project, person FROM sessions').get()).toEqual({
      launch_project: 'u7-school',
      person: null,
    });
    expect(after.query('SELECT text, project_id, focus FROM outcomes').get()).toEqual({
      text: 'Пункт',
      project_id: null,
      focus: null,
    });
    expect(after.query('SELECT superseded FROM segments').get()).toEqual({ superseded: 0 });
    expect(after.query('SELECT project_id FROM commits').get()).toEqual({ project_id: null });
    expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
    after.close();

    // сессии до появления людей отдаются единственному человеку из настроек
    expect(openStore(path).adoptOrphanSessions('nur')).toBe(1);
    expect(openStore(path).adoptOrphanSessions('nur')).toBe(0);
  });
});

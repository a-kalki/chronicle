import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

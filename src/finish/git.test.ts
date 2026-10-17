import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCommits } from './git.ts';

const repo = mkdtempSync(join(tmpdir(), 'chronicle-git-'));

function commit(file: string, message: string, date: string, email = 'me@example.com') {
  writeFileSync(join(repo, file), message);
  Bun.spawnSync(['git', 'add', file], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'x',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'x',
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

beforeAll(() => {
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'me@example.com'], { cwd: repo });
  commit('a.txt', 'до сегмента', '2026-10-17T04:00:00Z');
  commit('b.txt', 'в сегменте', '2026-10-17T05:30:00Z');
  commit('c.txt', 'чужой коммит', '2026-10-17T05:40:00Z', 'other@example.com');
  Bun.spawnSync(['git', 'checkout', '-q', '-b', 'feature'], { cwd: repo });
  commit('d.txt', 'в сегменте на ветке', '2026-10-17T05:50:00Z');
  commit('e.txt', 'после сегмента', '2026-10-17T07:00:00Z');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('collectCommits', () => {
  it('коммиты автора репо за интервал на всех ветках, с файлами, по времени', () => {
    const res = collectCommits(repo, '2026-10-17T05:00:00.000Z', '2026-10-17T06:00:00.000Z');
    expect(res.commits.map((c) => c.subject)).toEqual(['в сегменте', 'в сегменте на ветке']);
    expect(res.commits[0]?.at).toBe('2026-10-17T05:30:00.000Z');
    expect(res.files).toEqual(['b.txt', 'd.txt']);
  });

  it('вне git-репо — пусто, без ошибки', () => {
    expect(collectCommits(tmpdir(), '2026-10-17T05:00:00.000Z', '2026-10-17T06:00:00.000Z')).toEqual({
      commits: [],
      files: [],
    });
  });
});

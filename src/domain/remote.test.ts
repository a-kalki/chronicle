import { describe, expect, it } from 'bun:test';
import { normalizeRemote } from './remote.ts';

describe('normalizeRemote', () => {
  it('сводит ssh, scp-like и https к host/owner/repo', () => {
    const expected = 'github.com/nurgeo/u7-school';
    expect(normalizeRemote('git@github.com:NurGeo/u7-school.git')).toBe(expected);
    expect(normalizeRemote('https://github.com/NurGeo/u7-school.git')).toBe(expected);
    expect(normalizeRemote('https://github.com/NurGeo/u7-school/')).toBe(expected);
    expect(normalizeRemote('ssh://git@github.com:22/NurGeo/u7-school.git')).toBe(expected);
    expect(normalizeRemote('https://user:token@GitHub.com/NurGeo/u7-school')).toBe(expected);
  });

  it('сохраняет вложенные группы (gitlab)', () => {
    expect(normalizeRemote('git@gitlab.com:org/team/repo.git')).toBe('gitlab.com/org/team/repo');
  });

  it('возвращает null для нераспознанной строки', () => {
    expect(normalizeRemote('')).toBeNull();
    expect(normalizeRemote('/srv/git/repo.git')).toBeNull();
  });
});

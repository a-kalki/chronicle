import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { absPath, shellActions, turnText } from './paths.ts';

describe('absPath', () => {
  it('относительный путь — от cwd, ~ — домашний каталог', () => {
    expect(absPath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
    expect(absPath('/etc/x', '/repo')).toBe('/etc/x');
    expect(absPath('~/dev/x', '/repo')).toBe(`${homedir()}/dev/x`);
  });
});

describe('shellActions', () => {
  it('cd в команде — путь shell, в том числе в цепочке и в кавычках', () => {
    expect(shellActions('cd /home/nur/dev/tools/chronicle && bun test', '/school')).toEqual([
      { path: '/home/nur/dev/tools/chronicle', kind: 'shell' },
    ]);
    expect(shellActions('ls; cd "../other dir" && make', '/a/b')).toEqual([{ path: '/a/other dir', kind: 'shell' }]);
  });

  it('git -C и git без cd (в cwd)', () => {
    expect(shellActions('git -C ~/dev/x status', '/a')).toEqual([{ path: `${homedir()}/dev/x`, kind: 'shell' }]);
    expect(shellActions('git commit -m "x"', '/repo')).toEqual([{ path: '/repo', kind: 'shell' }]);
  });

  it('команда без cd и git путей не даёт', () => {
    expect(shellActions('bun test && echo cd', '/repo')).toEqual([]);
  });
});

describe('turnText', () => {
  it('однострочный текст реплики до 200 символов', () => {
    expect(turnText('привет\n\n  мир')).toBe('привет мир');
    expect(turnText('x'.repeat(300))).toHaveLength(201);
  });
});

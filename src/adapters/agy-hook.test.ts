import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgyHookDeps, onAgyExit, onAgyHook } from './agy-hook.ts';

describe('хук agy: текущий диалог процесса agy', () => {
  let dir: string;
  let finished: string[];
  let watched: number[];
  let alive: Set<number>;
  let subagents: Set<string>;
  let deps: AgyHookDeps;
  const state = (pid: number) => JSON.parse(readFileSync(join(dir, `${pid}.json`), 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chronicle-agy-hook-'));
    finished = [];
    watched = [];
    alive = new Set([100, 200]);
    subagents = new Set();
    deps = {
      dir,
      isAlive: (pid) => alive.has(pid),
      isUserConversation: (id) => !subagents.has(id),
      finish: (id) => finished.push(id),
      watch: (pid) => {
        watched.push(pid);
        const watcher = 9000 + watched.length;
        alive.add(watcher);
        return watcher;
      },
    };
  });

  it('первое событие процесса: запоминает диалог и запускает сторожа, finish нет', () => {
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    expect(state(100)).toEqual({ conversationId: 'a', watcherPid: 9001 });
    expect(watched).toEqual([100]);
    expect(finished).toEqual([]);
  });

  it('тот же диалог (следующий ход) — ничего не меняется, второго сторожа нет', () => {
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    expect(watched).toEqual([100]);
    expect(finished).toEqual([]);
  });

  it('смена диалога (/clear, /resume) — finish прошлого', () => {
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    onAgyHook({ conversationId: 'b', agyPid: 100 }, deps);
    expect(finished).toEqual(['a']);
    expect(state(100)).toEqual({ conversationId: 'b', watcherPid: 9001 });
    expect(watched).toEqual([100]);
  });

  it('сторож умер — запускается новый', () => {
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    alive.delete(9001);
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    expect(watched).toEqual([100, 100]);
    expect(state(100).watcherPid).toBe(9002);
  });

  it('диалог субагента не считается сменой диалога', () => {
    subagents.add('sub');
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    onAgyHook({ conversationId: 'sub', agyPid: 100 }, deps);
    expect(finished).toEqual([]);
    expect(state(100).conversationId).toBe('a');
  });

  it('разные процессы agy ведутся независимо', () => {
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    onAgyHook({ conversationId: 'b', agyPid: 200 }, deps);
    expect(finished).toEqual([]);
    expect(watched).toEqual([100, 200]);
  });

  it('выход agy — finish последнего диалога, состояние процесса удалено', () => {
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    onAgyHook({ conversationId: 'b', agyPid: 100 }, deps);
    onAgyExit(100, deps);
    expect(finished).toEqual(['a', 'b']);
    expect(existsSync(join(dir, '100.json'))).toBe(false);
  });

  it('выход без состояния (уже обработан) — ничего', () => {
    onAgyExit(100, deps);
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    onAgyExit(100, deps);
    onAgyExit(100, deps);
    expect(finished).toEqual(['a']);
  });

  it('осиротевшее состояние (agy и сторож мертвы: kill, перезагрузка) — finish при следующем хуке', () => {
    writeFileSync(join(dir, '300.json'), JSON.stringify({ conversationId: 'old', watcherPid: 301 }));
    writeFileSync(join(dir, '400.json'), JSON.stringify({ conversationId: 'live-agy', watcherPid: 401 }));
    alive.add(400);
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    expect(finished).toEqual(['old']);
    expect(readdirSync(dir).sort()).toEqual(['100.json', '400.json']);
  });

  it('agy мёртв, но сторож ещё жив — сирота не трогается: finish сделает сторож', () => {
    writeFileSync(join(dir, '300.json'), JSON.stringify({ conversationId: 'old', watcherPid: 301 }));
    alive.add(301);
    onAgyHook({ conversationId: 'a', agyPid: 100 }, deps);
    expect(finished).toEqual([]);
    expect(existsSync(join(dir, '300.json'))).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from './claude-code.ts';
import type { RunOptions } from './run.ts';

const ID = '4e6bfd2b-1d67-4903-93fb-96d9e3c8a4e9';
const line = (o: object) => `${JSON.stringify(o)}\n`;
const base = { sessionId: ID, cwd: '/home/nur/dev/kalki/u7-school' };

describe('ClaudeCodeAdapter.readSession', () => {
  let projects: string;
  let file: string;
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'chronicle-cc-'));
    mkdirSync(join(projects, '-home-nur-dev-kalki-u7-school'));
    file = join(projects, '-home-nur-dev-kalki-u7-school', `${ID}.jsonl`);
    writeFileSync(
      file,
      [
        line({ type: 'mode', mode: 'default' }),
        line({ ...base, type: 'user', timestamp: '2026-10-17T05:00:00.000Z', message: { content: 'привет' } }),
        line({ ...base, type: 'user', isMeta: true, timestamp: '2026-10-17T05:00:01.000Z', message: { content: 'x' } }),
        line({ ...base, type: 'assistant', timestamp: '2026-10-17T05:00:10.000Z', message: { content: [] } }),
        line({
          ...base,
          type: 'user',
          timestamp: '2026-10-17T05:00:20.000Z',
          message: { content: [{ type: 'tool_result', content: 'ok' }] },
        }),
        line({
          ...base,
          type: 'user',
          timestamp: '2026-10-17T05:01:00.000Z',
          message: { content: [{ type: 'text', text: 'дальше' }] },
        }),
      ].join(''),
    );
  });

  it('находит лог по ID, размечает реплики пользователя и действия агента, пропускает служебное', () => {
    const read = new ClaudeCodeAdapter(projects, undefined, () => 0).readSession(ID, null);
    expect(read?.cwd).toBe('/home/nur/dev/kalki/u7-school');
    expect(read?.events).toEqual([
      { at: '2026-10-17T05:00:00.000Z', actor: 'user' },
      { at: '2026-10-17T05:00:10.000Z', actor: 'agent' },
      { at: '2026-10-17T05:00:20.000Z', actor: 'agent' },
      { at: '2026-10-17T05:01:00.000Z', actor: 'user' },
    ]);
    expect(read?.watermark).toBe(6);
  });

  it('после watermark отдаёт только новые события; недописанная строка не учитывается', () => {
    const adapter = new ClaudeCodeAdapter(projects, undefined, () => 0);
    appendFileSync(
      file,
      line({ ...base, type: 'assistant', timestamp: '2026-10-17T05:02:00.000Z', message: { content: [] } }),
    );
    appendFileSync(file, '{"type":"assistant","timest');
    const read = adapter.readSession(ID, 6);
    expect(read?.events).toEqual([{ at: '2026-10-17T05:02:00.000Z', actor: 'agent' }]);
    expect(read?.watermark).toBe(7);
  });

  it('ходы: реплика человека и пути из вызовов инструментов агента до следующей реплики', () => {
    const tool = (name: string, input: object) => ({ type: 'tool_use', id: name, name, input });
    const at = (s: number) => `2026-10-17T05:02:${String(s).padStart(2, '0')}.000Z`;
    appendFileSync(
      file,
      [
        line({
          ...base,
          type: 'assistant',
          timestamp: at(1),
          message: {
            content: [
              { type: 'text', text: 'смотрю' },
              tool('Read', { file_path: '/home/nur/dev/tools/chronicle/README.md' }),
              tool('Edit', { file_path: '/home/nur/dev/tools/chronicle/src/a.ts', old_string: 'a', new_string: 'b' }),
              tool('Bash', { command: 'cd /home/nur/dev/tools/chronicle && git status', description: 'x' }),
              tool('Grep', { pattern: 'x', path: 'src' }),
              tool('NotebookEdit', { notebook_path: '/n/a.ipynb', new_source: '' }),
              tool('Bash', { command: 'bun test' }),
            ],
          },
        }),
        line({
          ...base,
          type: 'user',
          timestamp: at(2),
          message: { content: '<local-command-stdout>x</local-command-stdout>' },
        }),
        line({ ...base, type: 'user', timestamp: at(3), message: { content: 'третья\nреплика' } }),
      ].join(''),
    );
    const read = new ClaudeCodeAdapter(projects, undefined, () => 0).readSession(ID, null);
    expect(read?.turns.map((t) => [t.at, t.text])).toEqual([
      ['2026-10-17T05:00:00.000Z', 'привет'],
      ['2026-10-17T05:01:00.000Z', 'дальше'],
      [at(3), 'третья реплика'],
    ]);
    expect(read?.turns[0]?.actions).toEqual([]);
    expect(read?.turns[1]?.actions).toEqual([
      { path: '/home/nur/dev/tools/chronicle/README.md', kind: 'read' },
      { path: '/home/nur/dev/tools/chronicle/src/a.ts', kind: 'edit' },
      { path: '/home/nur/dev/tools/chronicle', kind: 'shell' },
      { path: '/home/nur/dev/kalki/u7-school/src', kind: 'read' },
      { path: '/n/a.ipynb', kind: 'edit' },
    ]);
  });

  it('работа агента до первой новой реплики относится к первому ходу сегмента', () => {
    appendFileSync(
      file,
      [
        line({
          ...base,
          type: 'assistant',
          timestamp: '2026-10-17T05:02:00.000Z',
          message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/x/a' } }] },
        }),
        line({ ...base, type: 'user', timestamp: '2026-10-17T05:03:00.000Z', message: { content: 'ещё' } }),
      ].join(''),
    );
    const read = new ClaudeCodeAdapter(projects, undefined, () => 0).readSession(ID, 6);
    expect(read?.turns).toEqual([
      { at: '2026-10-17T05:03:00.000Z', text: 'ещё', actions: [{ path: '/x/a', kind: 'edit' }] },
    ]);
  });

  it('форк: события старше создания лога (с запасом в минуту) — скопированная история, отбрасываются', () => {
    const created = Date.parse('2026-10-17T05:01:30.000Z');
    const read = new ClaudeCodeAdapter(projects, undefined, () => created).readSession(ID, null);
    expect(read?.events).toEqual([{ at: '2026-10-17T05:01:00.000Z', actor: 'user' }]);
  });

  it('неизвестная сессия — null', () => {
    expect(new ClaudeCodeAdapter(projects, undefined, () => 0).readSession('nope', null)).toBeNull();
  });
});

describe('ClaudeCodeAdapter.extract', () => {
  const options = { model: 'haiku', prompt: 'выжимка', schema: { type: 'object' }, cwd: '/proj', watermark: null };

  it('форк сессии без инструментов и без сохранения, ответ из structured_output', async () => {
    let call: { cmd: string[]; opts: RunOptions } | undefined;
    const adapter = new ClaudeCodeAdapter('/x', async (cmd, opts) => {
      call = { cmd, opts };
      return { code: 0, stdout: JSON.stringify({ is_error: false, structured_output: { ok: 1 } }), stderr: '' };
    });
    expect(await adapter.extract(ID, options)).toEqual({ ok: 1 });

    const cmd = call?.cmd ?? [];
    expect(cmd.slice(0, 2)).toEqual(['claude', '-p']);
    for (const flag of ['--fork-session', '--no-session-persistence']) expect(cmd).toContain(flag);
    expect(cmd[cmd.indexOf('--resume') + 1]).toBe(ID);
    expect(cmd[cmd.indexOf('--tools') + 1]).toBe('');
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('haiku');
    expect(cmd[cmd.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(cmd.at(-1)).toBe('выжимка');
    expect(call?.opts.cwd).toBe('/proj');
    expect(call?.opts.env.CHRONICLE_EXTRACT).toBe('1');
    expect(call?.opts.env.CLAUDECODE).toBeUndefined();
  });

  it('ошибка агента — исключение с причиной', async () => {
    const adapter = new ClaudeCodeAdapter('/x', async () => ({
      code: 1,
      stdout: JSON.stringify({ is_error: true, result: 'No conversation found' }),
      stderr: '',
    }));
    expect(adapter.extract(ID, options)).rejects.toThrow('No conversation found');
  });
});

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
  const options = { model: 'haiku', prompt: 'выжимка', schema: { type: 'object' }, cwd: '/proj' };

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

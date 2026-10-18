import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from './agy.ts';
import type { RunOptions } from './run.ts';

const ID = '2472d00f-417b-4dfa-a7c7-1cdd27aafe5f';
const line = (o: object) => `${JSON.stringify(o)}\n`;

describe('AgyAdapter.readSession', () => {
  let brainDir: string;
  let dbPath: string;
  let logFile: string;

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'chronicle-agy-brain-'));
    const sessionDir = join(brainDir, ID, '.system_generated/logs');
    mkdirSync(sessionDir, { recursive: true });
    logFile = join(sessionDir, 'transcript.jsonl');
    dbPath = join(brainDir, 'conversation_summaries.db');

    writeFileSync(
      logFile,
      [
        line({
          step_index: 0,
          source: 'SYSTEM',
          type: 'SYSTEM_PROMPT',
          created_at: '2026-10-18T09:20:00Z',
          content: 'system prompt',
        }),
        line({
          step_index: 1,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-18T09:22:28Z',
          content:
            '<USER_REQUEST>\nнужно реализовать запланированное\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>',
        }),
        line({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-18T09:22:30Z',
          tool_calls: [
            {
              name: 'view_file',
              args: { AbsolutePath: '"/home/nur/dev/tools/chronicle/docs/plan.md"' },
            },
          ],
        }),
        line({
          step_index: 3,
          source: 'MODEL',
          type: 'GENERIC',
          created_at: '2026-10-18T09:22:32Z',
          content: 'file contents',
        }),
        line({
          step_index: 4,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-18T09:25:00Z',
          content: 'продолжай',
        }),
      ].join(''),
    );
  });

  it('находит лог по ID, размечает события активности, ходы и действия', () => {
    const adapter = new AgyAdapter(brainDir, undefined, dbPath);
    const read = adapter.readSession(ID, null);
    expect(read).not.toBeNull();
    expect(read?.source).toBe('log');
    expect(read?.events).toEqual([
      { at: '2026-10-18T09:22:28Z', actor: 'user' },
      { at: '2026-10-18T09:22:30Z', actor: 'agent' },
      { at: '2026-10-18T09:22:32Z', actor: 'agent' },
      { at: '2026-10-18T09:25:00Z', actor: 'user' },
    ]);
    expect(read?.watermark).toBe(5);
    expect(read?.turns.map((t) => [t.at, t.text])).toEqual([
      ['2026-10-18T09:22:28Z', 'нужно реализовать запланированное'],
      ['2026-10-18T09:25:00Z', 'продолжай'],
    ]);
    expect(read?.turns[0]?.actions).toEqual([{ path: '/home/nur/dev/tools/chronicle/docs/plan.md', kind: 'read' }]);
    expect(read?.turns[1]?.actions).toEqual([]);
  });

  it('после watermark отдаёт только новые события; недописанная строка не учитывается', () => {
    const adapter = new AgyAdapter(brainDir, undefined, dbPath);
    appendFileSync(
      logFile,
      line({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-18T09:26:00Z',
      }),
    );
    appendFileSync(logFile, '{"step_index":6,"source":"MO');
    const read = adapter.readSession(ID, 5);
    expect(read?.events).toEqual([{ at: '2026-10-18T09:26:00Z', actor: 'agent' }]);
    expect(read?.watermark).toBe(6);
  });

  it('извлекает действия edit/read/shell из вызовов различных инструментов', () => {
    appendFileSync(
      logFile,
      [
        line({
          step_index: 5,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-18T09:26:00Z',
          tool_calls: [
            {
              name: 'run_command',
              args: {
                CommandLine: '"cd /home/nur/dev/tools/chronicle && git status"',
                Cwd: '"/home/nur/dev/kalki/u7-school"',
              },
            },
            {
              name: 'replace_file_content',
              args: {
                TargetFile: '"/home/nur/dev/tools/chronicle/src/a.ts"',
                TargetContent: 'foo',
                ReplacementContent: 'bar',
              },
            },
            {
              name: 'write_to_file',
              args: {
                TargetFile: '/home/nur/dev/tools/chronicle/src/b.ts',
                CodeContent: 'test',
              },
            },
            {
              name: 'view_file',
              args: { AbsolutePath: '/home/nur/dev/tools/chronicle/docs/spec.md' },
            },
          ],
        }),
        line({
          step_index: 6,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-18T09:30:00Z',
          content: 'готово',
        }),
      ].join(''),
    );
    const adapter = new AgyAdapter(brainDir, undefined, dbPath);
    const read = adapter.readSession(ID, null);
    const turn1 = read?.turns[1];
    expect(turn1?.text).toBe('продолжай');
    expect(turn1?.actions).toEqual([
      { path: '/home/nur/dev/tools/chronicle', kind: 'shell' },
      { path: '/home/nur/dev/tools/chronicle/src/a.ts', kind: 'edit' },
      { path: '/home/nur/dev/tools/chronicle/src/b.ts', kind: 'edit' },
      { path: '/home/nur/dev/tools/chronicle/docs/spec.md', kind: 'read' },
    ]);
  });

  it('работа агента до первой новой реплики относится к первому ходу сегмента', () => {
    appendFileSync(
      logFile,
      [
        line({
          step_index: 5,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-18T09:26:00Z',
          tool_calls: [
            {
              name: 'write_to_file',
              args: { TargetFile: '/home/nur/dev/tools/chronicle/x.ts' },
            },
          ],
        }),
        line({
          step_index: 6,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-18T09:27:00Z',
          content: 'следующий шаг',
        }),
      ].join(''),
    );
    const adapter = new AgyAdapter(brainDir, undefined, dbPath);
    const read = adapter.readSession(ID, 5);
    expect(read?.turns).toEqual([
      {
        at: '2026-10-18T09:27:00Z',
        text: 'следующий шаг',
        actions: [{ path: '/home/nur/dev/tools/chronicle/x.ts', kind: 'edit' }],
      },
    ]);
  });

  it('определяет cwd из conversation_summaries.db, если база есть', () => {
    const db = new Database(dbPath);
    db.run('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)');
    db.run('INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)', [
      ID,
      JSON.stringify(['file:///home/nur/dev/kalki/u7-school']),
    ]);
    db.close();

    const adapter = new AgyAdapter(brainDir, undefined, dbPath);
    const read = adapter.readSession(ID, null);
    expect(read?.cwd).toBe('/home/nur/dev/kalki/u7-school');
  });

  it('определяет cwd из run_command Cwd, если базы нет', () => {
    appendFileSync(
      logFile,
      line({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-18T09:26:00Z',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: 'ls', Cwd: '"/home/nur/dev/kalki/from-cmd"' },
          },
        ],
      }),
    );
    const adapter = new AgyAdapter(brainDir, undefined, '/non-existent-db.sqlite');
    const read = adapter.readSession(ID, null);
    expect(read?.cwd).toBe('/home/nur/dev/kalki/from-cmd');
  });

  it('неизвестная сессия — null', () => {
    const adapter = new AgyAdapter(brainDir, undefined, dbPath);
    expect(adapter.readSession('non-existent', null)).toBeNull();
  });
});

describe('AgyAdapter.extract', () => {
  const options = {
    model: 'gemini-3.8-flash-low',
    prompt: 'выжимка',
    schema: { type: 'object' },
    cwd: '/proj',
    watermark: null,
  };

  it('вызывает agy с нужными флагами и возвращает structured_output', async () => {
    let call: { cmd: string[]; opts: RunOptions } | undefined;
    const adapter = new AgyAdapter('/x', async (cmd, opts) => {
      call = { cmd, opts };
      return {
        code: 0,
        stdout: JSON.stringify({ status: 'SUCCESS', structured_output: { summary: 'ok' } }),
        stderr: '',
      };
    });

    const res = await adapter.extract(ID, options);
    expect(res).toEqual({ summary: 'ok' });

    const cmd = call?.cmd ?? [];
    expect(cmd[0]).toBe('agy');
    expect(cmd[cmd.indexOf('--conversation') + 1]).toBe(ID);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low');
    expect(cmd[cmd.indexOf('--effort') + 1]).toBe('low');
    expect(cmd).toContain('--disable-slash-commands');
    expect(cmd[cmd.indexOf('--output-format') + 1]).toBe('json');
    expect(cmd[cmd.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(cmd[cmd.indexOf('-p') + 1]).toBe('выжимка');

    expect(call?.opts.cwd).toBe('/proj');
    expect(call?.opts.env.CHRONICLE_EXTRACT).toBe('1');
    expect(call?.opts.env.ANTIGRAVITY_CONVERSATION_ID).toBeUndefined();
    expect(call?.opts.env.ANTIGRAVITY_AGENT).toBeUndefined();
  });

  it('ошибка agy — исключение с описанием', async () => {
    const adapter = new AgyAdapter('/x', async () => ({
      code: 1,
      stdout: JSON.stringify({ status: 'ERROR', error: 'conversation not found' }),
      stderr: '',
    }));
    expect(adapter.extract(ID, options)).rejects.toThrow('conversation not found');
  });

  it('невалидный вывод stdout — исключение', async () => {
    const adapter = new AgyAdapter('/x', async () => ({
      code: 1,
      stdout: 'some panic message',
      stderr: 'fatal error',
    }));
    expect(adapter.extract(ID, options)).rejects.toThrow('вывод не JSON');
  });
});

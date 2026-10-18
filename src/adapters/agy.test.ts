import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter, EXTRACT_PROMPT_HEAD as HEAD, isAgyUserConversation } from './agy.ts';
import type { RunOptions } from './run.ts';

const ID = '2472d00f-417b-4dfa-a7c7-1cdd27aafe5f';
const COPY = '99999999-0000-4000-8000-000000000000';
/** Начало общего промпта выжимки (prompts/extract.md) */
const EXTRACT_PROMPT_HEAD = 'Сессия завершается. Сделай выжимку этой сессии для сервиса chronicle';
const line = (o: object) => `${JSON.stringify(o)}\n`;

describe('AgyAdapter.readSession', () => {
  let root: string;
  let logFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chronicle-agy-'));
    const sessionDir = join(root, 'brain', ID, '.system_generated/logs');
    mkdirSync(sessionDir, { recursive: true });
    logFile = join(sessionDir, 'transcript.jsonl');

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
    const adapter = new AgyAdapter(root);
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
    const adapter = new AgyAdapter(root);
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
    const adapter = new AgyAdapter(root);
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
    const adapter = new AgyAdapter(root);
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
    const db = new Database(join(root, 'conversation_summaries.db'));
    db.run('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)');
    db.run('INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)', [
      ID,
      JSON.stringify(['file:///home/nur/dev/kalki/u7-school']),
    ]);
    db.close();

    const adapter = new AgyAdapter(root);
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
    const adapter = new AgyAdapter(root);
    const read = adapter.readSession(ID, null);
    expect(read?.cwd).toBe('/home/nur/dev/kalki/from-cmd');
  });

  it('промпт выжимки, попавший в диалог (старый способ без копии), и ответ на него — не работа сессии', () => {
    appendFileSync(
      logFile,
      [
        line({
          step_index: 5,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-18T09:40:00Z',
          content: `<USER_REQUEST>\n${EXTRACT_PROMPT_HEAD} ...\n</USER_REQUEST>`,
        }),
        line({
          step_index: 6,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-10-18T09:40:05Z',
          tool_calls: [{ name: 'finish', args: { work: '{}' } }],
        }),
        line({
          step_index: 7,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-18T09:50:00Z',
          content: '<USER_REQUEST>\nещё вопрос\n</USER_REQUEST>',
        }),
      ].join(''),
    );
    const read = new AgyAdapter(root).readSession(ID, 5);
    expect(read?.events).toEqual([{ at: '2026-10-18T09:50:00Z', actor: 'user' }]);
    expect(read?.turns.map((t) => t.text)).toEqual(['ещё вопрос']);
  });

  it('маркер промпта выжимки совпадает с началом prompts/extract.md', () => {
    expect(HEAD).toBe(EXTRACT_PROMPT_HEAD);
    expect(readFileSync(join(import.meta.dir, '../../prompts/extract.md'), 'utf8').startsWith(HEAD)).toBe(true);
  });

  it('неизвестная сессия — null', () => {
    const adapter = new AgyAdapter(root);
    expect(adapter.readSession('non-existent', null)).toBeNull();
  });
});

/** Диалог agy в миниатюре: conversations/<id>.db с id в trajectory_meta и в blob метаданных */
function makeConversation(root: string, id: string) {
  mkdirSync(join(root, 'conversations'), { recursive: true });
  const db = new Database(join(root, 'conversations', `${id}.db`));
  db.run('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT)');
  db.run('CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY DEFAULT "main", data BLOB)');
  db.run('INSERT INTO trajectory_meta VALUES (?, ?)', ['t-1', id]);
  db.run('INSERT INTO trajectory_metadata_blob VALUES (?, ?)', ['main', Buffer.from(`..${id}..file:///proj..`)]);
  db.close();
}

function makeSummaries(root: string, ids: string[]) {
  const db = new Database(join(root, 'conversation_summaries.db'));
  db.run('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)');
  for (const id of ids) db.run('INSERT INTO conversation_summaries VALUES (?, ?)', [id, '["file:///proj"]']);
  db.close();
}

const summaryIds = (root: string) =>
  (
    new Database(join(root, 'conversation_summaries.db'), { readonly: true })
      .query('SELECT conversation_id FROM conversation_summaries')
      .all() as { conversation_id: string }[]
  ).map((r) => r.conversation_id);

describe('AgyAdapter.extract', () => {
  const options = {
    model: 'gemini-3.8-flash-low',
    prompt: 'выжимка',
    schema: { type: 'object' },
    cwd: '/proj',
    watermark: null,
  };
  const ok = {
    code: 0,
    stdout: JSON.stringify({ status: 'SUCCESS', structured_output: { summary: 'ok' } }),
    stderr: '',
  };

  let root: string;
  const lastFile = () => join(root, 'cache/last_conversations.json');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chronicle-agy-'));
    makeConversation(root, ID);
    makeSummaries(root, [ID]);
    mkdirSync(join(root, 'cache'));
    writeFileSync(lastFile(), JSON.stringify({ '/proj': ID, '/other': 'x' }));
  });

  /** Runner, который ведёт себя как agy: создаёт следы диалога-копии */
  const agyLike =
    (seen: { cmd?: string[]; opts?: RunOptions; copy?: { cascade: string; blob: string } }, res = ok) =>
    async (cmd: string[], opts: RunOptions) => {
      seen.cmd = cmd;
      seen.opts = opts;
      const id = cmd[cmd.indexOf('--conversation') + 1] as string;
      const db = new Database(join(root, 'conversations', `${id}.db`), { readonly: true });
      seen.copy = {
        cascade: (db.query('SELECT cascade_id FROM trajectory_meta').get() as { cascade_id: string }).cascade_id,
        blob: Buffer.from(
          (db.query('SELECT data FROM trajectory_metadata_blob').get() as { data: Uint8Array }).data,
        ).toString(),
      };
      db.close();
      mkdirSync(join(root, 'brain', id), { recursive: true });
      mkdirSync(join(root, 'annotations'), { recursive: true });
      writeFileSync(join(root, 'annotations', `${id}.pbtxt`), '');
      writeFileSync(join(root, 'conversations', `${id}.db-wal`), '');
      const s = new Database(join(root, 'conversation_summaries.db'));
      s.run('INSERT INTO conversation_summaries VALUES (?, ?)', [id, '["file:///proj"]']);
      s.close();
      writeFileSync(lastFile(), JSON.stringify({ '/proj': id, '/other': 'x' }));
      return res;
    };

  it('выжимает копию диалога с нужными флагами и возвращает structured_output', async () => {
    const seen: Parameters<typeof agyLike>[0] = {};
    const adapter = new AgyAdapter(root, agyLike(seen), () => COPY);

    expect(await adapter.extract(ID, options)).toEqual({ summary: 'ok' });

    const cmd = seen.cmd ?? [];
    expect(cmd[0]).toBe('agy');
    expect(cmd[cmd.indexOf('--conversation') + 1]).toBe(COPY);
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low');
    expect(cmd[cmd.indexOf('--effort') + 1]).toBe('low');
    expect(cmd).toContain('--disable-slash-commands');
    expect(cmd[cmd.indexOf('--output-format') + 1]).toBe('json');
    expect(cmd[cmd.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    // -p забирает следующий аргумент как промпт — он последний
    expect(cmd.slice(-2)).toEqual(['-p', 'выжимка']);

    expect(seen.copy).toEqual({ cascade: COPY, blob: `..${COPY}..file:///proj..` });
    expect(seen.opts?.cwd).toBe('/proj');
    expect(seen.opts?.env.CHRONICLE_EXTRACT).toBe('1');
    expect(seen.opts?.env.ANTIGRAVITY_CONVERSATION_ID).toBeUndefined();
  });

  it('рабочий диалог не меняется, следы копии убираются, «последний диалог» workspace восстанавливается', async () => {
    const before = readFileSync(join(root, 'conversations', `${ID}.db`));
    await new AgyAdapter(root, agyLike({}), () => COPY).extract(ID, options);

    expect(readFileSync(join(root, 'conversations', `${ID}.db`)).equals(before)).toBe(true);
    expect(existsSync(join(root, 'conversations', `${COPY}.db`))).toBe(false);
    expect(existsSync(join(root, 'conversations', `${COPY}.db-wal`))).toBe(false);
    expect(existsSync(join(root, 'brain', COPY))).toBe(false);
    expect(existsSync(join(root, 'annotations', `${COPY}.pbtxt`))).toBe(false);
    expect(summaryIds(root)).toEqual([ID]);
    expect(JSON.parse(readFileSync(lastFile(), 'utf8'))).toEqual({ '/proj': ID, '/other': 'x' });
  });

  it('ошибка agy — исключение с описанием, копия всё равно убрана', async () => {
    const adapter = new AgyAdapter(
      root,
      agyLike({}, { code: 1, stdout: JSON.stringify({ status: 'ERROR', error: 'quota exceeded' }), stderr: '' }),
      () => COPY,
    );
    expect(adapter.extract(ID, options)).rejects.toThrow('quota exceeded');
    await Bun.sleep(0);
    expect(existsSync(join(root, 'conversations', `${COPY}.db`))).toBe(false);
    expect(summaryIds(root)).toEqual([ID]);
  });

  it('невалидный вывод stdout — исключение', async () => {
    const adapter = new AgyAdapter(root, agyLike({}, { code: 1, stdout: 'panic', stderr: 'fatal' }), () => COPY);
    expect(adapter.extract(ID, options)).rejects.toThrow('вывод не JSON');
  });

  it('нет файла диалога — исключение без запуска agy', async () => {
    let ran = false;
    const adapter = new AgyAdapter(
      root,
      async () => {
        ran = true;
        return ok;
      },
      () => COPY,
    );
    expect(adapter.extract('no-such', options)).rejects.toThrow('диалог no-such не найден');
    expect(ran).toBe(false);
  });
});

describe('isAgyUserConversation', () => {
  it('диалог человека — в логе есть его реплика; субагент (только SYSTEM и MODEL) и диалог без лога — нет', () => {
    const root = mkdtempSync(join(tmpdir(), 'chronicle-agy-'));
    const log = (id: string, lines: object[]) => {
      const dir = join(root, 'brain', id, '.system_generated/logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'transcript.jsonl'), lines.map(line).join(''));
    };
    log('main', [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'привет' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'привет' },
    ]);
    log('sub', [
      { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'задача от родителя' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Париж' },
    ]);
    expect(isAgyUserConversation('main', root)).toBe(true);
    expect(isAgyUserConversation('sub', root)).toBe(false);
    expect(isAgyUserConversation('no-log-yet', root)).toBe(false);
  });
});

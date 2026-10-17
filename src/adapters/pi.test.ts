import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAdapter } from './pi.ts';
import type { RunOptions } from './run.ts';

const ID = '01a10f7f-79b3-742e-9346-91a8e72938c2';
const line = (o: object) => `${JSON.stringify(o)}\n`;
const msg = (role: string, timestamp: string) => line({ type: 'message', timestamp, message: { role, content: [] } });

describe('PiAdapter.readSession', () => {
  let sessions: string;
  let file: string;
  beforeEach(() => {
    sessions = mkdtempSync(join(tmpdir(), 'chronicle-pi-'));
    mkdirSync(join(sessions, '--home-nur-dev-kalki-u7-school--'));
    file = join(sessions, '--home-nur-dev-kalki-u7-school--', `2026-10-06T04-36-14-899Z_${ID}.jsonl`);
    writeFileSync(
      file,
      [
        line({ type: 'session', id: ID, timestamp: '2026-10-06T04:36:14.899Z', cwd: '/home/nur/dev/kalki/u7-school' }),
        line({ type: 'model_change', timestamp: '2026-10-06T04:36:15.000Z' }),
        msg('system', '2026-10-06T04:36:16.000Z'),
        msg('user', '2026-10-06T04:37:00.000Z'),
        msg('assistant', '2026-10-06T04:37:10.000Z'),
        msg('toolResult', '2026-10-06T04:37:20.000Z'),
      ].join(''),
    );
  });

  it('cwd из заголовка; user — реплики, assistant и toolResult — агент, system пропускается', () => {
    const read = new PiAdapter(sessions).readSession(ID, null);
    expect(read?.cwd).toBe('/home/nur/dev/kalki/u7-school');
    expect(read?.events).toEqual([
      { at: '2026-10-06T04:37:00.000Z', actor: 'user' },
      { at: '2026-10-06T04:37:10.000Z', actor: 'agent' },
      { at: '2026-10-06T04:37:20.000Z', actor: 'agent' },
    ]);
    expect(read?.watermark).toBe(6);
  });

  it('после watermark — только новые события', () => {
    const read = new PiAdapter(sessions).readSession(ID, 5);
    expect(read?.events).toEqual([{ at: '2026-10-06T04:37:20.000Z', actor: 'agent' }]);
  });

  it('форк: события старше заголовка сессии (с запасом в минуту) — скопированная история, отбрасываются', () => {
    const forked = join(sessions, '--home-nur-dev-kalki-u7-school--', `2026-10-06T05-00-00-000Z_fork-1.jsonl`);
    writeFileSync(
      forked,
      [
        line({ type: 'session', id: 'fork-1', timestamp: '2026-10-06T05:00:00.000Z', cwd: '/proj' }),
        msg('user', '2026-10-06T04:37:00.000Z'),
        msg('assistant', '2026-10-06T04:37:10.000Z'),
        msg('user', '2026-10-06T05:00:30.000Z'),
      ].join(''),
    );
    expect(new PiAdapter(sessions).readSession('fork-1', null)?.events).toEqual([
      { at: '2026-10-06T05:00:30.000Z', actor: 'user' },
    ]);
  });

  it('неизвестная сессия — null', () => {
    expect(new PiAdapter(sessions).readSession('nope', null)).toBeNull();
  });

  it('extract: форк файла сессии во временный каталог без инструментов, схема в промпте, каталог удаляется', async () => {
    let call: { cmd: string[]; opts: RunOptions } | undefined;
    const adapter = new PiAdapter(sessions, async (cmd, opts) => {
      call = { cmd, opts };
      return { code: 0, stdout: '```json\n{"work": {"summary": "ок"}}\n```\n', stderr: '' };
    });
    const res = await adapter.extract(ID, {
      model: 'deepseek/deepseek-flash',
      prompt: 'выжимка',
      schema: { type: 'object' },
      cwd: '/proj',
      watermark: null,
    });
    expect(res).toEqual({ work: { summary: 'ок' } });

    const cmd = call?.cmd ?? [];
    expect(cmd.slice(0, 2)).toEqual(['pi', '-p']);
    expect(cmd[cmd.indexOf('--fork') + 1]).toBe(file);
    expect(cmd).toContain('--no-tools');
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('deepseek/deepseek-flash');
    expect(cmd.at(-1)).toContain('выжимка');
    expect(cmd.at(-1)).toContain('{"type":"object"}');
    const sessionDir = cmd[cmd.indexOf('--session-dir') + 1] as string;
    expect(sessionDir.startsWith(sessions)).toBe(false);
    expect(existsSync(sessionDir)).toBe(false);
    expect(call?.opts.env.CHRONICLE_EXTRACT).toBe('1');
  });

  it('extract: ответ без JSON — исключение', async () => {
    const adapter = new PiAdapter(sessions, async () => ({ code: 0, stdout: 'не могу', stderr: '' }));
    expect(adapter.extract(ID, { model: 'm', prompt: 'p', schema: {}, cwd: '/proj', watermark: null })).rejects.toThrow(
      'JSON',
    );
  });

  it('extract: брошенные ветки после watermark попадают в промпт отдельным разделом', async () => {
    const branched = join(sessions, '--home-nur-dev-kalki-u7-school--', '2026-10-06T06-00-00-000Z_br-1.jsonl');
    const m = (id: string, parentId: string | null, role: string, text: string) =>
      line({ type: 'message', id, parentId, timestamp: '2026-10-06T06:00:10.000Z', message: { role, content: text } });
    writeFileSync(
      branched,
      [
        line({ type: 'session', id: 'br-1', timestamp: '2026-10-06T06:00:00.000Z', cwd: '/proj' }),
        m('u1', null, 'user', 'начало'),
        m('u2', 'u1', 'user', 'брошенная попытка'),
        m('u3', 'u1', 'user', 'активная ветка'),
      ].join(''),
    );
    const prompts: string[] = [];
    const adapter = new PiAdapter(sessions, async (cmd) => {
      prompts.push(cmd.at(-1) as string);
      return { code: 0, stdout: '{}', stderr: '' };
    });
    const opts = { model: 'm', prompt: 'p', schema: {}, cwd: '/proj' };
    await adapter.extract('br-1', { ...opts, watermark: null });
    expect(prompts[0]).toContain('Брошенные ветки');
    expect(prompts[0]).toContain('брошенная попытка');

    await adapter.extract('br-1', { ...opts, watermark: 4 });
    expect(prompts[1]).not.toContain('Брошенные ветки');
  });
});

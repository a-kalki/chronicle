import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox } from '../cli/outbox.ts';
import type { AgentAdapter, SessionRead } from './adapter.ts';
import { runFinish } from './finish.ts';
import { FinishState } from './state.ts';

const at = (m: number) => new Date(Date.UTC(2026, 9, 17, 5, m)).toISOString();
const extractOk = { work: { summary: 'Сделано', items: ['пункт'] }, knowledge: [], usage: [] };

/** Фейковый адаптер: лог — список событий, watermark — число прочитанных. */
function fakeAdapter(log: SessionRead['events'], extract: () => unknown = () => extractOk) {
  const calls = { extract: 0 };
  const adapter: AgentAdapter = {
    name: 'fake',
    defaultExtractModel: 'cheap',
    readSession(_id, watermark) {
      const from = (watermark as number | null) ?? 0;
      return { cwd: tmpdir(), source: 'log', events: log.slice(from), watermark: log.length };
    },
    async extract() {
      calls.extract++;
      return extract();
    },
  };
  return { adapter, calls };
}

describe('runFinish', () => {
  let outbox: Outbox;
  let state: FinishState;
  let sent: unknown[];
  const send = async (r: unknown) => {
    sent.push(r);
    return { kind: 'delivered' as const, body: {} };
  };

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'chronicle-finish-'));
    outbox = new Outbox(join(dir, 'outbox'));
    state = new FinishState(join(dir, 'state'));
    sent = [];
  });

  const finish = (adapter: AgentAdapter) =>
    runFinish({ adapter, sessionId: 's-1', host: 'laptop', outbox, send, state, log: () => {} });

  const events: SessionRead['events'] = [
    { at: at(0), actor: 'user' },
    { at: at(5), actor: 'agent' },
    { at: at(20), actor: 'user' },
    { at: at(25), actor: 'agent' },
  ];

  it('собирает отчёт сегмента по контракту и доставляет его', async () => {
    const res = await finish(fakeAdapter(events).adapter);
    expect(res.status).toBe('reported');

    const report = sent[0] as {
      session: { agent: string; seq: number; startedAt: string; endedAt: string };
      work: { summary: string; commits: unknown[] };
      activity: { events: unknown[] };
    };
    expect(report.session).toMatchObject({ agent: 'fake', seq: 1, startedAt: at(0), endedAt: at(25) });
    expect(report.work.summary).toBe('Сделано');
    expect(report.activity.events).toHaveLength(4);
  });

  it('следующий finish той же сессии — следующий сегмент только с новыми событиями', async () => {
    const log = [...events];
    const { adapter } = fakeAdapter(log);
    await finish(adapter);
    log.push({ at: at(40), actor: 'user' }, { at: at(45), actor: 'agent' });
    await finish(adapter);

    const second = sent[1] as { session: { seq: number; startedAt: string }; activity: { events: unknown[] } };
    expect(second.session.seq).toBe(2);
    expect(second.session.startedAt).toBe(at(40));
    expect(second.activity.events).toHaveLength(2);
  });

  it('без новой активности или без реплик пользователя — пропуск без выжимки', async () => {
    const { adapter, calls } = fakeAdapter([
      { at: at(0), actor: 'agent' },
      { at: at(5), actor: 'agent' },
    ]);
    expect((await finish(adapter)).status).toBe('skipped');
    expect(calls.extract).toBe(0);
  });

  it('тривиальный сегмент (меньше минуты, без коммитов) пропускается, состояние не сдвигается', async () => {
    const quick = [
      { at: '2026-10-17T05:00:00.000Z', actor: 'user' as const },
      { at: '2026-10-17T05:00:20.000Z', actor: 'agent' as const },
    ];
    const { adapter, calls } = fakeAdapter(quick);
    expect((await finish(adapter)).status).toBe('skipped');
    expect(calls.extract).toBe(0);
    expect(state.load('fake', 's-1')).toBeNull();
  });

  it('невалидная выжимка — одна повторная попытка, потом ошибка без сдвига состояния', async () => {
    let n = 0;
    const flaky = fakeAdapter(events, () => (n++ === 0 ? { work: {} } : extractOk));
    expect((await finish(flaky.adapter)).status).toBe('reported');
    expect(flaky.calls.extract).toBe(2);

    const broken = fakeAdapter(events, () => ({ nope: true }));
    const res = await runFinish({
      adapter: broken.adapter,
      sessionId: 's-2',
      host: 'laptop',
      outbox,
      send,
      state,
      log: () => {},
    });
    expect(res.status).toBe('failed');
    expect(state.load('fake', 's-2')).toBeNull();
  });

  it('параллельный finish той же сессии не запускается', async () => {
    const release = state.lock('fake', 's-1');
    expect(release).not.toBeNull();
    expect((await finish(fakeAdapter(events).adapter)).status).toBe('skipped');
    release?.();
  });

  it('при недоступном сервере отчёт в очереди, состояние сдвинуто (повторной выжимки не будет)', async () => {
    const res = await runFinish({
      adapter: fakeAdapter(events).adapter,
      sessionId: 's-1',
      host: 'laptop',
      outbox,
      send: async () => ({ kind: 'unavailable', error: 'down' }),
      state,
      log: () => {},
    });
    expect(res.status).toBe('reported');
    expect(outbox.list()).toHaveLength(1);
    expect(state.load('fake', 's-1')?.seq).toBe(1);
  });
});

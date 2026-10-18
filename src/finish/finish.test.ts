import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox } from '../cli/outbox.ts';
import type { AgentAdapter, SessionRead } from './adapter.ts';
import { runFinish } from './finish.ts';
import { FinishState } from './state.ts';

const at = (m: number) => new Date(Date.UTC(2026, 9, 17, 5, m)).toISOString();
const extractOk = {
  work: { summary: 'Сделано', episodes: [{ from: 1, to: 9, focus: 'Фокус', items: ['пункт'] }] },
  knowledge: [],
  usage: [],
};

/** Ход на каждую реплику пользователя; действия — по времени реплики */
const turnsOf = (
  events: SessionRead['events'],
  actions: Record<string, SessionRead['turns'][number]['actions']> = {},
) =>
  events
    .filter((e) => e.actor === 'user')
    .map((e) => ({ at: e.at, text: `реплика ${e.at}`, actions: actions[e.at] ?? [] }));

/** Фейковый адаптер: лог — список событий, watermark — число прочитанных. */
function fakeAdapter(
  log: SessionRead['events'],
  extract: () => unknown = () => extractOk,
  actions: Record<string, SessionRead['turns'][number]['actions']> = {},
  cwd = tmpdir(),
) {
  const calls = { extract: 0, prompts: [] as string[] };
  const adapter: AgentAdapter = {
    name: 'fake',
    defaultExtractModel: 'cheap',
    readSession(_id, watermark) {
      const from = (watermark as number | null) ?? 0;
      const events = log.slice(from);
      return { cwd, source: 'log', events, turns: turnsOf(events, actions), watermark: log.length };
    },
    async extract(_id, options) {
      calls.extract++;
      calls.prompts.push(options.prompt);
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

  it('выжимка продолжения знает итоги прошлых сегментов и просит описать только новое', async () => {
    const log = [...events];
    let n = 0;
    const { adapter, calls } = fakeAdapter(log, () => ({
      work: { summary: n++ === 0 ? 'Сделан контракт' : 'Сделан CLI', episodes: extractOk.work.episodes },
      knowledge: [],
      usage: [],
    }));
    await finish(adapter);
    expect(calls.prompts[0]).not.toContain('Уже отправлено');

    log.push({ at: at(40), actor: 'user' }, { at: at(45), actor: 'agent' });
    await finish(adapter);
    expect(calls.prompts[1]).toContain('Уже отправлено');
    expect(calls.prompts[1]).toContain('Сделан контракт');
    expect(state.load('fake', 's-1')?.summaries).toEqual(['Сделан контракт: пункт', 'Сделан CLI: пункт']);
  });

  it('ходы нумеруются сквозь сегменты, промпт получает их список', async () => {
    const log = [...events];
    const { adapter, calls } = fakeAdapter(log);
    await finish(adapter);
    log.push({ at: at(40), actor: 'user' }, { at: at(45), actor: 'agent' });
    await finish(adapter);

    const first = sent[0] as { turns: { idx: number; focus: string }[] };
    const second = sent[1] as { turns: { idx: number }[] };
    expect(first.turns.map((t) => [t.idx, t.focus])).toEqual([
      [1, 'Фокус'],
      [2, 'Фокус'],
    ]);
    expect(second.turns.map((t) => t.idx)).toEqual([3]);
    expect(calls.prompts[0]).toContain(`#1 `);
    expect(calls.prompts[0]).toContain(`«реплика ${at(0)}»`);
    expect(calls.prompts[1]).toContain(`#3 `);
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

  it('проект хода — по путям; коммиты и файлы — из всех репо ходов; результаты — с проектом эпизода', async () => {
    const repos: Record<string, { name: string; path: string; remote?: string }> = {
      '/school': { name: 'u7-school', path: '/school', remote: 'github.com/nurgeo/u7-school' },
      '/chronicle': { name: 'chronicle', path: '/chronicle', remote: 'github.com/a-kalki/chronicle' },
      '/docs': { name: 'docs', path: '/docs' },
    };
    const find = (path: string) => repos[`/${path.split('/')[1]}`] ?? null;
    const collected: string[] = [];
    const extract = () => ({
      work: {
        summary: 'Две части',
        episodes: [
          { from: 1, to: 1, focus: 'Школа', items: ['Расписание'] },
          { from: 2, to: 2, focus: 'Учёт', items: ['Модель v2'] },
        ],
      },
      knowledge: [],
      usage: [],
    });
    const { adapter, calls } = fakeAdapter(
      events,
      extract,
      {
        [at(20)]: [
          { path: '/chronicle/src/a.ts', kind: 'edit' },
          { path: '/school/README.md', kind: 'read' },
          { path: '/docs/a.md', kind: 'read' },
        ],
      },
      '/school/src',
    );
    state.rememberFocuses({ 'github.com/a-kalki/chronicle': ['Учёт'] });
    const res = await runFinish({
      adapter,
      sessionId: 's-1',
      host: 'laptop',
      outbox,
      send,
      state,
      log: () => {},
      findRepo: find,
      collectCommits: (repo) => {
        collected.push(repo);
        return repo === '/chronicle'
          ? { commits: [{ hash: 'abc', subject: 'feat: x', at: at(22) }], files: ['src/a.ts'] }
          : { commits: [], files: [] };
      },
    });
    expect(res.status).toBe('reported');
    const report = sent[0] as {
      launch: { projectKey: string };
      projects: { key: string; name: string }[];
      turns: { idx: number; at: string; projectKey: string; focus: string }[];
      work: { outcomes: unknown[]; commits: { projectKey: string }[]; files: unknown[] };
    };
    const key = (name: string) => report.projects.find((p) => p.name === name)?.key ?? '';
    // первый ход без путей — проект запуска; docs только читали, и он ни одному ходу не достался — в отчёт не попадает
    expect(report.projects.map((p) => p.name).sort()).toEqual(['chronicle', 'u7-school']);
    expect(report.launch.projectKey).toBe(key('u7-school') as string);
    expect(report.turns).toEqual([
      { idx: 1, at: at(0), projectKey: key('u7-school'), focus: 'Школа' },
      { idx: 2, at: at(20), projectKey: key('chronicle'), focus: 'Учёт' },
    ]);
    expect(report.work.outcomes).toEqual([
      { projectKey: key('u7-school'), focus: 'Школа', text: 'Расписание' },
      { projectKey: key('chronicle'), focus: 'Учёт', text: 'Модель v2' },
    ]);
    expect(report.work.commits[0]?.projectKey).toBe(key('chronicle') as string);
    expect(report.work.files).toEqual([{ projectKey: key('chronicle'), path: 'src/a.ts' }]);
    expect(collected.sort()).toEqual(['/chronicle', '/school']);
    expect(calls.prompts[0]).toContain('chronicle: «Учёт»');
    expect(state.recentFocuses('github.com/nurgeo/u7-school')).toEqual(['Школа']);
  });

  it('replay: лог с начала, нумерация ходов с 1, replace, без знаний; следующий seq', async () => {
    const withKnowledge = () => ({
      ...extractOk,
      knowledge: [{ scope: 'global', kind: 'trap', title: 't', symptoms: ['e'], cause: 'c', fix: 'f', tags: [] }],
    });
    const { adapter, calls } = fakeAdapter(events, withKnowledge);
    await finish(adapter);
    const res = await runFinish({
      adapter,
      sessionId: 's-1',
      host: 'laptop',
      outbox,
      send,
      state,
      log: () => {},
      replay: true,
    });
    expect(res.status).toBe('reported');
    const replayed = sent[1] as {
      replace: boolean;
      session: { seq: number; startedAt: string };
      turns: { idx: number }[];
      knowledge: unknown[];
    };
    expect(replayed.replace).toBe(true);
    expect(replayed.session).toMatchObject({ seq: 2, startedAt: at(0) });
    expect(replayed.turns.map((t) => t.idx)).toEqual([1, 2]);
    expect(replayed.knowledge).toEqual([]);
    expect(calls.prompts[1]).toContain('Пересборка');
    expect(calls.prompts[1]).not.toContain('Уже отправлено');
    expect(state.load('fake', 's-1')).toMatchObject({ seq: 2, turns: 2 });
  });
});

import { beforeEach, describe, expect, it } from 'bun:test';
import { openStore, type SqliteStore } from '../infra/sqlite-store.ts';
import { createHandler } from './server.ts';

const TOKEN = 'secret';
const project = { name: 'u7-school', host: 'laptop', path: '/school', remote: 'github.com/nurgeo/u7-school' };

const report = {
  version: 1,
  session: {
    agent: 'pi',
    id: 's-1',
    host: 'laptop',
    seq: 1,
    startedAt: '2026-10-17T05:00:00.000Z',
    endedAt: '2026-10-17T06:00:00.000Z',
  },
  project: { remote: project.remote, name: project.name, path: project.path },
  activity: { source: 'coarse', events: [] },
  work: { summary: 'Сделано', items: [], commits: [], files: [] },
  knowledge: [],
  usage: [],
};

describe('HTTP API /v1', () => {
  let store: SqliteStore;
  let handle: (req: Request) => Promise<Response>;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    handle(
      new Request(`http://chronicle${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }),
    );

  beforeEach(() => {
    store = openStore(':memory:');
    handle = createHandler({ store, tokens: [{ token: TOKEN, person: 'nur' }] });
  });

  it('health доступен без токена', async () => {
    expect((await call('/v1/health', {}, null)).status).toBe(200);
  });

  it('без верного токена — 401', async () => {
    expect((await call('/v1/knowledge/search?q=x', {}, null)).status).toBe(401);
    expect((await call('/v1/knowledge/search?q=x', {}, 'wrong')).status).toBe(401);
  });

  it('POST /v1/reports принимает отчёт (202), повтор — 200 с duplicate', async () => {
    const first = await call('/v1/reports', { method: 'POST', body: JSON.stringify(report) });
    expect(first.status).toBe(202);
    const second = await call('/v1/reports', { method: 'POST', body: JSON.stringify(report) });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { duplicate: boolean }).duplicate).toBe(true);
  });

  it('сессия отчёта получает человека по токену', async () => {
    const res = await call('/v1/reports', { method: 'POST', body: JSON.stringify(report) });
    const { segmentId } = (await res.json()) as { segmentId: number };
    expect(store.getSegment(segmentId)?.person).toBe('nur');
  });

  it('GET /v1/facts: сегменты дня по часовому поясу; по умолчанию — свои, person=* — все', async () => {
    await call('/v1/reports', { method: 'POST', body: JSON.stringify(report) });
    const mine = (await (await call('/v1/facts?day=2026-10-17')).json()) as {
      from: string;
      settings: { timezone: string };
      segments: { person: string; agentSessionId: string }[];
    };
    expect(mine.from).toBe('2026-10-16T19:00:00.000Z');
    expect(mine.settings.timezone).toBe('Asia/Oral');
    expect(mine.segments.map((s) => s.agentSessionId)).toEqual(['s-1']);

    const other = (await (await call('/v1/facts?day=2026-10-17&person=ali')).json()) as { segments: unknown[] };
    expect(other.segments).toEqual([]);
    const all = (await (await call('/v1/facts?day=2026-10-17&person=*')).json()) as { segments: unknown[] };
    expect(all.segments).toHaveLength(1);
    const otherDay = (await (await call('/v1/facts?day=2026-10-18')).json()) as { segments: unknown[] };
    expect(otherDay.segments).toEqual([]);
    expect((await call('/v1/facts?day=вчера')).status).toBe(422);
  });

  it('POST /v1/reports на нарушение контракта — 422 с описанием', async () => {
    const res = await call('/v1/reports', { method: 'POST', body: JSON.stringify({ ...report, version: 9 }) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it('POST /v1/reports на невалидный JSON — 400', async () => {
    expect((await call('/v1/reports', { method: 'POST', body: '{' })).status).toBe(400);
  });

  it('поиск, просмотр и отметка пользы', async () => {
    store.createProject(project);
    store.insertEntry({
      id: 'K-ssh',
      projectId: null,
      kind: 'trap',
      title: 'ssh-деплой: bun не найден',
      symptoms: ['bun: command not found'],
      cause: 'PATH',
      fix: 'export PATH',
      tags: [],
    });
    const qs = new URLSearchParams({ q: 'bun command not found', ...project }).toString();
    const search = (await (await call(`/v1/knowledge/search?${qs}`)).json()) as { id: string }[];
    expect(search[0]?.id).toBe('K-ssh');

    const entry = await call('/v1/knowledge/K-ssh');
    expect(((await entry.json()) as { fix: string }).fix).toBe('export PATH');
    expect((await call('/v1/knowledge/K-none')).status).toBe(404);

    const used = await call('/v1/knowledge/K-ssh/usage', { method: 'POST', body: JSON.stringify({ helped: true }) });
    expect(used.status).toBe(204);
  });

  it('неизвестный маршрут — 404', async () => {
    expect((await call('/v1/nope')).status).toBe(404);
  });

  it('POST /v1/import/entries импортирует записи, нарушение схемы — 422', async () => {
    const entry = {
      id: 'R-x',
      project: null,
      kind: 'fact',
      title: 't',
      symptoms: [],
      cause: 'c',
      fix: 'f',
      tags: [],
      note: 'pi-chronicle: fact',
    };
    const ok = await call('/v1/import/entries', { method: 'POST', body: JSON.stringify({ entries: [entry] }) });
    expect(((await ok.json()) as { imported: string[] }).imported).toEqual(['R-x']);
    const bad = await call('/v1/import/entries', { method: 'POST', body: JSON.stringify({ entries: [{}] }) });
    expect(bad.status).toBe(422);
  });
});

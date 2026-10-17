import { beforeEach, describe, expect, it } from 'bun:test';
import { openStore, type SqliteStore } from '../infra/sqlite-store.ts';
import { createHandler } from './server.ts';

const TOKEN = 'secret';

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown> & {
    tools?: { name: string; inputSchema: object }[];
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

describe('MCP /mcp', () => {
  let store: SqliteStore;
  let handle: (req: Request) => Promise<Response>;
  let nextId = 1;

  const post = (body: unknown, token: string | null = TOKEN) =>
    handle(
      new Request('http://chronicle/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  const rpc = async (method: string, params: unknown = {}) =>
    (await (await post({ jsonrpc: '2.0', id: nextId++, method, params })).json()) as RpcResponse;
  const call = (name: string, args: unknown) => rpc('tools/call', { name, arguments: args });

  beforeEach(() => {
    store = openStore(':memory:');
    handle = createHandler({ store, tokens: [TOKEN] });
    store.createProject({ name: 'u7-school', host: 'laptop', path: '/school', remote: 'github.com/nurgeo/u7-school' });
    store.insertEntry({
      id: 'K-ssh',
      projectId: null,
      kind: 'trap',
      title: 'ssh-деплой: bun не найден',
      symptoms: ['bash: line 1: bun: command not found'],
      cause: 'PATH неинтерактивной сессии',
      fix: 'export PATH="$HOME/.bun/bin:$PATH"',
      tags: ['ssh'],
    });
    store.insertEntry({
      id: 'K-school',
      projectId: 'u7-school',
      kind: 'fact',
      title: 'Снапшоты потоков ссылаются на uuid шагов',
      symptoms: ['шаг выпадает из пути студента'],
      cause: 'c',
      fix: 'f',
      tags: [],
    });
  });

  it('без токена — 401', async () => {
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status).toBe(401);
  });

  it('initialize: версия протокола клиента, возможности tools, имя сервера', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(res.result?.protocolVersion).toBe('2025-06-18');
    expect(res.result?.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result?.serverInfo).toMatchObject({ name: 'chronicle' });
  });

  it('уведомление (без id) — 202 без тела', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('tools/list: только чтение и учёт пользы, со схемами входа', async () => {
    const res = await rpc('tools/list');
    expect(res.result?.tools?.map((t) => t.name).sort()).toEqual([
      'knowledge_get',
      'knowledge_search',
      'knowledge_used',
    ]);
    for (const t of res.result?.tools ?? []) expect(t.inputSchema).toMatchObject({ type: 'object' });
  });

  it('knowledge_search: с remote проекта — его записи и общие; без remote — только общие', async () => {
    const withProject = await call('knowledge_search', {
      query: 'шаг uuid снапшот',
      project_remote: 'git@github.com:NurGeo/u7-school.git',
    });
    expect(withProject.result?.content?.[0]?.text).toContain('K-school');

    const globalOnly = await call('knowledge_search', { query: 'шаг uuid снапшот' });
    expect(globalOnly.result?.content?.[0]?.text).not.toContain('K-school');

    const byError = await call('knowledge_search', { query: 'bun: command not found' });
    expect(byError.result?.structuredContent?.hits).toMatchObject([{ id: 'K-ssh' }]);
  });

  it('knowledge_get возвращает запись; неизвестная — isError', async () => {
    const entry = await call('knowledge_get', { id: 'K-ssh' });
    expect(entry.result?.content?.[0]?.text).toContain('export PATH="$HOME/.bun/bin:$PATH"');
    const missing = await call('knowledge_get', { id: 'K-none' });
    expect(missing.result?.isError).toBe(true);
  });

  it('knowledge_used отмечает пользу', async () => {
    const res = await call('knowledge_used', { id: 'K-ssh', helped: true });
    expect(res.result?.isError).toBeFalsy();
    expect(store.getEntry('K-ssh')?.helped).toBe(1);
  });

  it('неверные аргументы — isError с описанием; неизвестный инструмент и метод — ошибки JSON-RPC', async () => {
    const bad = await call('knowledge_search', { query: 42 });
    expect(bad.result?.isError).toBe(true);
    expect((await call('report_submit', {})).error?.code).toBe(-32602);
    expect((await rpc('resources/list')).error?.code).toBe(-32601);
  });

  it('невалидный JSON — ошибка разбора', async () => {
    const res = (await (await post('{')).json()) as RpcResponse;
    expect(res.error?.code).toBe(-32700);
  });

  it('GET /mcp — 405 (поток событий не поддерживается)', async () => {
    const res = await handle(new Request('http://chronicle/mcp', { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(405);
  });
});

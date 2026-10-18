/**
 * MCP (Streamable HTTP, POST /mcp): только чтение базы знаний и учёт пользы.
 * Отчёты сессий через MCP не принимаются — только через CLI с outbox (docs/data-and-api.md, раздел 6).
 * Ответ — обычный JSON (потоки не нужны): initialize, ping, tools/list, tools/call.
 */
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import { formatEntry } from '../app/format.ts';
import { getEntry, recordUsage, searchEntries } from '../app/knowledge.ts';
import type { Store } from '../app/store.ts';
import { normalizeRemote } from '../domain/remote.ts';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS =
  'База ловушек и неочевидных фактов окружения, общая для всех агентов. При неожиданной ошибке или странном ' +
  'поведении инструмента — до того, как чинить: knowledge_search с дословным текстом ошибки, затем knowledge_get. ' +
  'Помогла ли запись — knowledge_used.';

const SearchArgs = v.object({
  query: v.pipe(v.string(), v.minLength(1)),
  project_remote: v.optional(v.string()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
});
const GetArgs = v.object({ id: v.pipe(v.string(), v.minLength(1)) });
const UsedArgs = v.object({ id: v.pipe(v.string(), v.minLength(1)), helped: v.nullable(v.boolean()) });

const describe = <T extends v.GenericSchema>(schema: T, props: Record<string, string>) => {
  const json = toJsonSchema(schema) as { properties: Record<string, Record<string, unknown>> };
  for (const [k, d] of Object.entries(props)) if (json.properties[k]) json.properties[k].description = d;
  return json;
};

const TOOLS = [
  {
    name: 'knowledge_search',
    description:
      'Нечёткий поиск ловушек и фактов. Лучший запрос — дословный текст ошибки. Ищет в общих записях и, если ' +
      'передан project_remote, в записях этого проекта.',
    inputSchema: describe(SearchArgs, {
      query: 'Дословный текст ошибки или суть проблемы',
      project_remote: 'git remote текущего репозитория (git remote get-url origin) — для записей проекта',
      limit: 'Сколько записей вернуть (по умолчанию 10)',
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'knowledge_get',
    description: 'Запись целиком: симптомы, причина, решение.',
    inputSchema: describe(GetArgs, { id: 'ID записи из knowledge_search' }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'knowledge_used',
    description: 'Отметить, помогла ли запись (true / false / null — непонятно). Нужно для оценки пользы базы.',
    inputSchema: describe(UsedArgs, { id: 'ID записи', helped: 'Помогла ли запись' }),
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
];

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const text = (t: string, structured?: Record<string, unknown>, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(structured ? { structuredContent: structured } : {}),
  ...(isError ? { isError } : {}),
});

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function parseArgs<T extends v.GenericSchema>(schema: T, args: unknown): v.InferOutput<T> | string {
  const res = v.safeParse(schema, args ?? {});
  return res.success ? res.output : res.issues.map((i) => `${v.getDotPath(i) ?? 'аргументы'}: ${i.message}`).join('; ');
}

function callTool(store: Store, name: string, args: unknown): ToolResult {
  if (name === 'knowledge_search') {
    const a = parseArgs(SearchArgs, args);
    if (typeof a === 'string') return text(a, undefined, true);
    const remote = a.project_remote ? normalizeRemote(a.project_remote) : null;
    const projectId = remote ? store.findProjectByRemote(remote) : null;
    const hits = searchEntries(store, { q: a.query, projectId, limit: a.limit });
    const lines = hits.map((h) => `• [${h.id}] (${h.kind}, ${h.scope}) ${h.title}`);
    return text(lines.join('\n') || 'Ничего не найдено.', { hits });
  }
  if (name === 'knowledge_get') {
    const a = parseArgs(GetArgs, args);
    if (typeof a === 'string') return text(a, undefined, true);
    const entry = getEntry(store, a.id);
    return entry ? text(formatEntry(entry)) : text(`Запись ${a.id} не найдена`, undefined, true);
  }
  if (name === 'knowledge_used') {
    const a = parseArgs(UsedArgs, args);
    if (typeof a === 'string') return text(a, undefined, true);
    return recordUsage(store, a.id, a.helped) ? text('Отмечено.') : text(`Запись ${a.id} не найдена`, undefined, true);
  }
  throw new RpcError(-32602, `неизвестный инструмент: ${name}`);
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function dispatch(store: Store, req: RpcRequest): unknown {
  switch (req.method) {
    case 'initialize': {
      const requested = String(req.params?.protocolVersion ?? '');
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'chronicle', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(store, String(req.params?.name ?? ''), req.params?.arguments);
    default:
      throw new RpcError(-32601, `метод не поддерживается: ${req.method}`);
  }
}

const rpcResponse = (
  id: RpcRequest['id'],
  body: { result: unknown } | { error: { code: number; message: string } },
) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  ...body,
});

function handleOne(store: Store, req: RpcRequest): unknown | null {
  // Уведомления (без id) ответа не требуют
  if (req.id === undefined) return null;
  try {
    return rpcResponse(req.id, { result: dispatch(store, req) });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    return rpcResponse(req.id, { error: { code, message: e instanceof Error ? e.message : String(e) } });
  }
}

export async function handleMcp(store: Store, req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcResponse(null, { error: { code: -32700, message: 'невалидный JSON' } }));
  }
  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]) as RpcRequest[];
  const replies = requests.map((r) => handleOne(store, r)).filter((r) => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}

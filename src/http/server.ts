/** HTTP API /v1 — тонкий адаптер над use case'ами. */
import * as v from 'valibot';
import { getEntry, recordUsage, searchKnowledge } from '../app/knowledge.ts';
import type { Store } from '../app/store.ts';
import { submitReport } from '../app/submit-report.ts';

export interface HandlerDeps {
  store: Store;
  tokens: string[];
  /** Сигнал о новых кандидатах в знания (запуск курирования) */
  onCandidates?: () => void;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const empty = (status: number) => new Response(null, { status });

const UsageBody = v.object({ helped: v.nullable(v.boolean()) });

export function createHandler({ store, tokens, onCandidates }: HandlerDeps): (req: Request) => Promise<Response> {
  const authorized = (req: Request) => {
    const header = req.headers.get('authorization') ?? '';
    return tokens.some((t) => header === `Bearer ${t}`);
  };

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/v1/health') return json({ ok: true });
    if (!authorized(req)) return json({ error: 'unauthorized' }, 401);

    if (req.method === 'POST' && path === '/v1/reports') {
      const body = await req.json().catch(() => undefined);
      if (body === undefined) return json({ error: 'невалидный JSON' }, 400);
      const res = submitReport(store, body);
      if (!res.ok) return json({ issues: res.issues }, 422);
      if (res.candidates > 0) onCandidates?.();
      return json(res, res.duplicate ? 200 : 202);
    }

    if (req.method === 'GET' && path === '/v1/knowledge/search') {
      const p = url.searchParams;
      const hits = searchKnowledge(store, {
        q: p.get('q') ?? '',
        project: {
          name: p.get('name') ?? '',
          host: p.get('host') ?? '',
          path: p.get('path') ?? '',
          remote: p.get('remote') ?? undefined,
        },
        limit: Number(p.get('limit') ?? 10),
      });
      return json(hits);
    }

    const entry = path.match(/^\/v1\/knowledge\/([^/]+)(\/usage)?$/);
    if (entry?.[1]) {
      const id = decodeURIComponent(entry[1]);
      if (req.method === 'GET' && !entry[2]) {
        const found = getEntry(store, id);
        return found ? json(found) : json({ error: 'not found' }, 404);
      }
      if (req.method === 'POST' && entry[2]) {
        const body = v.safeParse(UsageBody, await req.json().catch(() => undefined));
        if (!body.success) return json({ error: 'ожидается { helped: boolean | null }' }, 422);
        return recordUsage(store, id, body.output.helped) ? empty(204) : json({ error: 'not found' }, 404);
      }
    }

    return json({ error: 'not found' }, 404);
  };
}

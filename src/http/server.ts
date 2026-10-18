/** HTTP API /v1 — тонкий адаптер над use case'ами. */
import * as v from 'valibot';
import { getFacts } from '../app/facts.ts';
import { importEntries } from '../app/import-entries.ts';
import { getEntry, recordUsage, searchKnowledge } from '../app/knowledge.ts';
import type { Store } from '../app/store.ts';
import { submitReport } from '../app/submit-report.ts';
import { dayBounds } from '../domain/day.ts';
import { handleMcp } from './mcp.ts';

export interface HandlerDeps {
  store: Store;
  /** Токен клиента → человек, чьи отчёты приходят с ним */
  tokens: { token: string; person: string }[];
  /** Сигнал о новых кандидатах в знания (запуск курирования) */
  onCandidates?: () => void;
  /** Настройки проекций: порог простоя и часовой пояс границы дня */
  settings?: { idleGapMinutes: number; timezone: string };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const empty = (status: number) => new Response(null, { status });

const UsageBody = v.object({ helped: v.nullable(v.boolean()) });

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function createHandler({
  store,
  tokens,
  onCandidates,
  settings = { idleGapMinutes: 30, timezone: 'Asia/Oral' },
}: HandlerDeps): (req: Request) => Promise<Response> {
  /** Человек по токену запроса; null — токен неверный */
  const personOf = (req: Request): string | null => {
    const header = req.headers.get('authorization') ?? '';
    return tokens.find((t) => header === `Bearer ${t.token}`)?.person ?? null;
  };

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/v1/health') return json({ ok: true });
    const person = personOf(req);
    if (person === null) return json({ error: 'unauthorized' }, 401);

    if (path === '/mcp') return handleMcp(store, req);

    if (req.method === 'POST' && path === '/v1/reports') {
      const body = await req.json().catch(() => undefined);
      if (body === undefined) return json({ error: 'невалидный JSON' }, 400);
      const res = submitReport(store, body, person);
      if (!res.ok) return json({ issues: res.issues }, 422);
      if (res.candidates > 0) onCandidates?.();
      return json(res, res.duplicate ? 200 : 202);
    }

    if (req.method === 'GET' && path === '/v1/facts') {
      const p = url.searchParams;
      const day = p.get('day');
      const bounds =
        day && DAY.test(day) ? dayBounds(day, settings.timezone) : { from: p.get('from'), to: p.get('to') };
      if (!bounds.from || !bounds.to || Number.isNaN(Date.parse(bounds.from)) || Number.isNaN(Date.parse(bounds.to))) {
        return json({ error: 'ожидается day=YYYY-MM-DD или from и to (ISO 8601)' }, 422);
      }
      // по умолчанию — факты того, чей токен; person=* — все люди
      const who = p.get('person') ?? person;
      const query = { from: bounds.from, to: bounds.to, person: who === '*' ? null : who, project: p.get('project') };
      return json(getFacts(store, query, settings));
    }

    if (req.method === 'POST' && path === '/v1/import/entries') {
      const res = importEntries(store, await req.json().catch(() => undefined));
      return res.ok ? json(res) : json({ issues: res.issues }, 422);
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

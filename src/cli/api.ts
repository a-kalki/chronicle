/** HTTP-клиент сервиса. Сетевые сбои и 5xx — «недоступен» (отчёт останется в очереди). */
import type { SearchHit } from '../app/knowledge.ts';
import type { KnowledgeEntry, ProjectRef } from '../app/store.ts';
import type { SendResult } from './outbox.ts';

const TIMEOUT_MS = 5000;

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async sendReport(report: unknown): Promise<SendResult> {
    try {
      const res = await this.request('/v1/reports', { method: 'POST', body: JSON.stringify(report) });
      if (res.ok) return { kind: 'delivered', body: await res.json() };
      if (res.status === 422) return { kind: 'rejected', issues: ((await res.json()) as { issues: string[] }).issues };
      return { kind: 'unavailable', error: `HTTP ${res.status}` };
    } catch (e) {
      return { kind: 'unavailable', error: String(e) };
    }
  }

  async search(q: string, project: ProjectRef, limit = 10): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q, name: project.name, host: project.host, path: project.path });
    if (project.remote) params.set('remote', project.remote);
    params.set('limit', String(limit));
    return (await this.ok(await this.request(`/v1/knowledge/search?${params}`))).json() as Promise<SearchHit[]>;
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const res = await this.request(`/v1/knowledge/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    return (await this.ok(res)).json() as Promise<KnowledgeEntry>;
  }

  async usage(id: string, helped: boolean | null): Promise<boolean> {
    const res = await this.request(`/v1/knowledge/${encodeURIComponent(id)}/usage`, {
      method: 'POST',
      body: JSON.stringify({ helped }),
    });
    if (res.status === 404) return false;
    await this.ok(res);
    return true;
  }

  private async ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`chronicle: HTTP ${res.status} ${await res.text()}`);
    return res;
  }
}

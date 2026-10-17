import { describe, expect, it } from 'bun:test';
import type { Llm } from '../app/llm.ts';
import { submitReport } from '../app/submit-report.ts';
import { openStore } from '../infra/sqlite-store.ts';
import { startCurator } from './curator.ts';

function addCandidate(store: ReturnType<typeof openStore>, id: string) {
  submitReport(store, {
    version: 1,
    session: {
      agent: 'pi',
      id,
      host: 'laptop',
      seq: 1,
      startedAt: '2026-10-17T05:00:00.000Z',
      endedAt: '2026-10-17T06:00:00.000Z',
    },
    project: { name: 'p', path: '/p' },
    activity: { source: 'coarse', events: [] },
    work: { summary: 'x', items: [], commits: [], files: [] },
    knowledge: [{ scope: 'global', kind: 'fact', title: `факт ${id}`, symptoms: [], cause: 'c', fix: 'f', tags: [] }],
    usage: [],
  });
}

describe('startCurator', () => {
  it('kick курирует очередь; одновременные kick не запускают параллельных проходов', async () => {
    const store = openStore(':memory:');
    let active = 0;
    let maxActive = 0;
    const llm: Llm = {
      async completeJson() {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(10);
        active--;
        return { action: 'discard', reason: 'тест' };
      },
    };
    const curator = startCurator({ store, llm, intervalMs: 60_000, archiveAfterDays: 120, log: () => {} });

    addCandidate(store, 'a');
    curator.kick();
    addCandidate(store, 'b');
    curator.kick();
    await curator.idle();
    curator.stop();

    expect(store.pendingCandidates()).toEqual([]);
    expect(maxActive).toBe(1);
  });
});

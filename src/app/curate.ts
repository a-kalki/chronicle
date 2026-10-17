/**
 * Курирование знаний: кандидаты из отчётов → решение LLM (create / merge / discard) → курированная база.
 * Кандидаты неизменяемы; неудачная попытка оставляет кандидата pending для повтора.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { KnowledgeCandidate } from '../../contract/v1.ts';
import { similarity, stems } from '../domain/similarity.ts';
import { entryText } from './knowledge.ts';
import type { Llm } from './llm.ts';
import type { KnowledgeEntry, PendingCandidate, Store } from './store.ts';

const SYSTEM_PROMPT = readFileSync(join(import.meta.dir, '../../prompts/curate.md'), 'utf8');

/** Сколько похожих записей показывать LLM и с какой минимальной схожестью */
const SIMILAR_LIMIT = 5;
const SIMILAR_MIN = 0.1;

const Reason = v.pipe(v.string(), v.minLength(1));
const Decision = v.variant('action', [
  v.object({ action: v.literal('create'), reason: Reason, entry: KnowledgeCandidate }),
  v.object({ action: v.literal('merge'), targetId: v.string(), reason: Reason, entry: KnowledgeCandidate }),
  v.object({ action: v.literal('discard'), reason: Reason }),
]);

export interface CurateResult {
  created: number;
  merged: number;
  discarded: number;
  failed: number;
}

function similarEntries(store: Store, c: PendingCandidate): KnowledgeEntry[] {
  const own = stems(entryText({ id: '', title: c.title, symptoms: c.symptoms, tags: c.tags }));
  return store
    .activeEntries(c.projectId)
    .map((e) => ({ e, score: similarity(own, stems(entryText(e))) }))
    .filter((x) => x.score >= SIMILAR_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, SIMILAR_LIMIT)
    .map((x) => x.e);
}

function newEntryId(store: Store, at = new Date()): string {
  const day = at.toISOString().slice(0, 10).replaceAll('-', '');
  for (;;) {
    const id = `K-${day}-${Math.random().toString(36).slice(2, 6)}`;
    if (!store.getEntry(id)) return id;
  }
}

function userPrompt(c: PendingCandidate, similar: KnowledgeEntry[]): string {
  const { id: _id, segmentId: _seg, ...candidate } = c;
  const shown = similar.map(({ id, projectId, kind, title, symptoms, cause, fix, tags }) => ({
    id,
    scope: projectId ? 'project' : 'global',
    kind,
    title,
    symptoms,
    cause,
    fix,
    tags,
  }));
  return JSON.stringify({ project: c.projectId, candidate, similar: shown }, null, 2);
}

async function curateOne(store: Store, llm: Llm, c: PendingCandidate): Promise<keyof CurateResult> {
  const similar = similarEntries(store, c);
  const parsed = v.safeParse(Decision, await llm.completeJson(SYSTEM_PROMPT, userPrompt(c, similar)));
  if (!parsed.success) {
    throw new Error(
      `ответ LLM не по схеме: ${parsed.issues.map((i) => `${v.getDotPath(i)}: ${i.message}`).join('; ')}`,
    );
  }
  const d = parsed.output;

  if (d.action === 'discard') {
    store.decideCandidate(c.id, 'discarded', null, d.reason);
    return 'discarded';
  }

  const { scope, ...fields } = d.entry;
  const entry = { ...fields, projectId: scope === 'project' ? c.projectId : null };

  if (d.action === 'merge') {
    if (!similar.some((e) => e.id === d.targetId)) {
      throw new Error(`merge в ${d.targetId}: такой записи нет среди показанных похожих`);
    }
    store.transaction(() => {
      store.updateEntry(d.targetId, entry);
      store.addHistory(d.targetId, c.id, 'merged', d.reason);
      store.decideCandidate(c.id, 'merged', d.targetId, d.reason);
    });
    return 'merged';
  }

  const id = newEntryId(store);
  store.transaction(() => {
    store.insertEntry({ id, ...entry });
    store.addHistory(id, c.id, 'created', d.reason);
    store.decideCandidate(c.id, 'created', id, d.reason);
  });
  return 'created';
}

/** Курирует все pending-кандидаты по очереди: следующий видит записи, созданные предыдущими. */
export async function curatePending(store: Store, llm: Llm): Promise<CurateResult> {
  const res: CurateResult = { created: 0, merged: 0, discarded: 0, failed: 0 };
  for (const c of store.pendingCandidates()) {
    try {
      res[await curateOne(store, llm, c)]++;
    } catch (e) {
      store.failCandidate(c.id, e instanceof Error ? e.message : String(e));
      res.failed++;
    }
  }
  return res;
}

/** Переводит в архив записи без использования дольше порога; возвращает их ID. */
export function archiveStale(store: Store, afterDays: number, at = new Date()): string[] {
  const cutoff = new Date(at.getTime() - afterDays * 86_400_000).toISOString();
  const ids = store.staleEntryIds(cutoff);
  store.transaction(() => {
    for (const id of ids) {
      store.archiveEntry(id);
      store.addHistory(id, null, 'archived', `не использовалась ${afterDays} дн.`);
    }
  });
  return ids;
}

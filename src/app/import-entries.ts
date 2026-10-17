/**
 * Импорт готовых (уже отобранных человеком) записей знаний из прежних систем — мимо курирования.
 * Идемпотентен по ID записи; вся пачка — одна транзакция.
 */
import * as v from 'valibot';
import type { Store } from './store.ts';

const Text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

const ImportedEntry = v.object({
  id: v.pipe(Text(200), v.regex(/^[\w.-]+$/, 'ID: буквы, цифры, ._-')),
  /** null — общий scope */
  project: v.nullable(v.object({ name: Text(100), host: Text(64), path: Text(1000), remote: v.optional(Text(300)) })),
  kind: v.picklist(['trap', 'fact']),
  title: Text(200),
  symptoms: v.array(Text(1000)),
  cause: Text(2000),
  fix: Text(4000),
  tags: v.array(Text(40)),
  /** Откуда запись — уходит в историю */
  note: Text(500),
  stats: v.optional(v.object({ opened: Count, helped: Count }), { opened: 0, helped: 0 }),
});

export const ImportBody = v.object({ entries: v.pipe(v.array(ImportedEntry), v.maxLength(1000)) });

export type ImportResult = { ok: true; imported: string[]; skipped: string[] } | { ok: false; issues: string[] };

export function importEntries(store: Store, input: unknown): ImportResult {
  const parsed = v.safeParse(ImportBody, input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.issues.map((i) => `${v.getDotPath(i) ?? '(корень)'}: ${i.message}`) };
  }

  return store.transaction(() => {
    const res = { ok: true as const, imported: [] as string[], skipped: [] as string[] };
    for (const { id, project, note, stats, ...fields } of parsed.output.entries) {
      if (store.getEntry(id)) {
        res.skipped.push(id);
        continue;
      }
      const projectId = project ? (store.matchProject(project) ?? store.createProject(project)) : null;
      store.insertEntry({ id, projectId, ...fields });
      store.addHistory(id, null, 'imported', note);
      for (let i = 0; i < stats.opened; i++) store.markOpened(id);
      for (let i = 0; i < stats.helped; i++) store.insertUsage(id, null, true);
      res.imported.push(id);
    }
    return res;
  });
}

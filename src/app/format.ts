/** Текстовое представление записи знаний — для CLI и MCP. */
import type { KnowledgeEntry } from './store.ts';

export function formatEntry(e: KnowledgeEntry): string {
  const lines = [`# ${e.title}`, '', `- **${e.id}** (${e.kind}, ${e.projectId ?? 'global'})`];
  if (e.symptoms.length > 0) lines.push('', '## Симптомы', ...e.symptoms.map((s) => `- \`${s}\``));
  lines.push('', '## Причина', e.cause, '', '## Решение', e.fix);
  if (e.tags.length > 0) lines.push('', `Теги: ${e.tags.join(', ')}`);
  return lines.join('\n');
}

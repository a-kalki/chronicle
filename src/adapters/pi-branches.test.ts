import { describe, expect, it } from 'bun:test';
import { abandonedBranchesText, type PiLine } from './pi-branches.ts';

const ts = (m: number) => new Date(Date.UTC(2026, 9, 10, 7, m)).toISOString();
const user = (id: string, parentId: string | null, text: string, m: number): PiLine => ({
  type: 'message',
  id,
  parentId,
  timestamp: ts(m),
  message: { role: 'user', content: text },
});
const assistant = (id: string, parentId: string, m: number, content: unknown[]): PiLine => ({
  type: 'message',
  id,
  parentId,
  timestamp: ts(m),
  message: { role: 'assistant', content },
});
const toolError = (id: string, parentId: string, m: number, text: string): PiLine => ({
  type: 'message',
  id,
  parentId,
  timestamp: ts(m),
  message: { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text }] },
});

/**
 * Дерево:
 *   u1 ─ a1 ─┬─ u2 ─ a2(bash) ─ e2(ошибка)          ← брошенная ветка A
 *            ├─ u3 ─ a3                             ← брошенная ветка B (покрыта branch_summary)
 *            └─ u4 ─ a4                             ← активная ветка (последняя запись)
 */
const header: PiLine = { type: 'session', timestamp: ts(0) };
const lines: PiLine[] = [
  header,
  user('u1', null, 'Сделай сборку', 1),
  assistant('a1', 'u1', 2, [{ type: 'text', text: 'Пробую варианты' }]),
  user('u2', 'a1', 'Через bun build', 3),
  assistant('a2', 'u2', 4, [
    { type: 'thinking', thinking: 'скрытые рассуждения' },
    { type: 'toolCall', name: 'bash', arguments: { command: 'bun build src/index.ts' } },
  ]),
  toolError('e2', 'a2', 5, "error: Could not resolve: 'node:sqlite'"),
  user('u3', 'a1', 'Через esbuild', 6),
  assistant('a3', 'u3', 7, [{ type: 'text', text: 'esbuild тоже не подошёл' }]),
  { type: 'branch_summary', id: 'bs', parentId: 'a1', timestamp: ts(8), fromId: 'a3' },
  user('u4', 'bs', 'Тогда оставим как есть', 9),
  assistant('a4', 'u4', 10, [{ type: 'text', text: 'Оставил' }]),
];

describe('abandonedBranchesText', () => {
  it('раскладывает брошенную ветку: реплики, текст ассистента, вызовы и ошибки инструментов', () => {
    const text = abandonedBranchesText(lines, 0);
    expect(text).toContain('Через bun build');
    expect(text).toContain('bash');
    expect(text).toContain('bun build src/index.ts');
    expect(text).toContain("error: Could not resolve: 'node:sqlite'");
  });

  it('не включает активную ветку, рассуждения и ветки, уже покрытые branch_summary', () => {
    const text = abandonedBranchesText(lines, 0);
    expect(text).not.toContain('Тогда оставим как есть');
    expect(text).not.toContain('Сделай сборку');
    expect(text).not.toContain('скрытые рассуждения');
    expect(text).not.toContain('esbuild');
  });

  it('учитывает только записи после watermark', () => {
    expect(abandonedBranchesText(lines, 6)).toBe('');
  });

  it('без брошенных веток — пустая строка', () => {
    expect(abandonedBranchesText([header, ...lines.slice(1, 3)], 0)).toBe('');
  });

  it('ограничивает длину', () => {
    const long = [header, user('r', null, 'x', 1), user('b', null, 'я'.repeat(5000), 2), user('c', 'r', 'конец', 3)];
    const text = abandonedBranchesText(long, 0, 300);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain('обрезано');
  });

  it('сворачивает раскрытый скил в реплике пользователя и пропускает вызовы только для чтения', () => {
    const skill = `<skill name="conductor-implement" location="/x/SKILL.md">\n${'длинный текст скила '.repeat(100)}</skill>\nреализуй трек`;
    const tree = [
      header,
      user('r', null, 'база', 1),
      user('b', 'r', skill, 2),
      assistant('ba', 'b', 3, [
        { type: 'toolCall', name: 'read', arguments: { path: 'plan.md' } },
        { type: 'toolCall', name: 'edit', arguments: { path: 'src/a.ts' } },
        { type: 'toolCall', name: 'bash', arguments: { command: 'ls -la arcade/' } },
        { type: 'toolCall', name: 'bash', arguments: { command: 'bun test arcade/' } },
        { type: 'toolCall', name: 'dcp_prune', arguments: { ids: ['1'] } },
      ]),
      user('c', 'r', 'активная', 4),
    ];
    const text = abandonedBranchesText(tree, 0);
    expect(text).toContain('[скил conductor-implement]');
    expect(text).toContain('реализуй трек');
    expect(text).not.toContain('длинный текст скила');
    expect(text).toContain('src/a.ts');
    expect(text).not.toContain('plan.md');
    expect(text).not.toContain('ls -la');
    expect(text).toContain('bun test arcade/');
    expect(text).not.toContain('dcp_prune');
  });

  it('делит лимит между ветками: последняя ветка не вытесняется первой', () => {
    const tree = [
      header,
      user('r', null, 'база', 1),
      user('b1', 'r', 'первая задача', 2),
      ...Array.from({ length: 30 }, (_, i) => user(`b1-${i}`, i ? `b1-${i - 1}` : 'b1', 'я'.repeat(900), 3)),
      user('b2', 'r', 'вторая задача', 4),
      user('c', 'r', 'активная', 5),
    ];
    const text = abandonedBranchesText(tree, 0, 6000);
    expect(text).toContain('первая задача');
    expect(text).toContain('вторая задача');
    expect(text.length).toBeLessThanOrEqual(6500);
  });
});

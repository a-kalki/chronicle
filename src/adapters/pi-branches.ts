/**
 * Брошенные ветки сессии pi. Модель (и форк для выжимки) видит только активную ветку — путь от корня
 * до последней записи. Ветки, оставленные через /tree без branch_summary, иначе пропали бы из итога сессии,
 * хотя ловушки чаще всего рождаются именно в них. Здесь они раскладываются в компактный текст для промпта.
 */

export interface PiLine {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  /** branch_summary: лист ветки, которую резюмировали */
  fromId?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean };
}

/** Лимиты на кусок текста: от вывода инструментов нужна только суть */
const LIMITS = { user: 1000, assistant: 1500, toolCall: 200, toolError: 600 };
const ROLES = new Set(['user', 'assistant', 'toolResult']);
/** Вызовы только для чтения и служебные (dcp_* — сжатие контекста) ничего не говорят о сделанном */
const READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep']);
const READ_ONLY_COMMANDS = /^\s*(ls|cat|head|tail|grep|rg|find|pwd|echo|wc|which|tree)\b/;

function isNoise(call: { name?: string; arguments?: { command?: unknown } }): boolean {
  const name = call.name ?? '';
  if (READ_ONLY_TOOLS.has(name) || name.startsWith('dcp_')) return true;
  return name === 'bash' && READ_ONLY_COMMANDS.test(String(call.arguments?.command ?? ''));
}
const CUT = '\n…(обрезано)';

/** pi раскрывает скил прямо в реплике пользователя — оставляем только его имя */
export const collapseSkills = (text: string) =>
  text.replace(/<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g, '[скил $1]');

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n');
}

function render(l: PiLine): string[] {
  const m = l.message ?? {};
  if (m.role === 'user') return [`Пользователь: ${clip(collapseSkills(textOf(m.content)), LIMITS.user)}`];
  if (m.role === 'toolResult') {
    return m.isError ? [`✖ ${m.toolName ?? 'инструмент'}: ${clip(textOf(m.content), LIMITS.toolError)}`] : [];
  }
  const out: string[] = [];
  const text = textOf(m.content).trim();
  if (text) out.push(`Агент: ${clip(text, LIMITS.assistant)}`);
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c?.type === 'toolCall' && !isNoise(c)) {
      out.push(`→ ${c.name}(${clip(JSON.stringify(c.arguments ?? {}), LIMITS.toolCall)})`);
    }
  }
  return out;
}

/**
 * Текст брошенных веток среди записей с индексом ≥ fromIndex (watermark адаптера);
 * ветки, покрытые branch_summary, пропускаются. Пустая строка — брошенных веток нет.
 */
export function abandonedBranchesText(lines: PiLine[], fromIndex: number, maxChars = 20_000): string {
  const byId = new Map<string, PiLine>();
  for (const l of lines) if (l.id && l.type !== 'session') byId.set(l.id, l);

  const leaf = lines.findLast((l) => l.id && l.type !== 'session');
  const active = new Set<string>();
  for (let cur = leaf; cur?.id; cur = cur.parentId ? byId.get(cur.parentId) : undefined) active.add(cur.id);

  // Корень брошенной ветки — первая запись вне активного пути, считая от развилки
  const branchRoot = (id: string): string => {
    let cur = byId.get(id);
    while (cur?.parentId && !active.has(cur.parentId) && byId.has(cur.parentId)) cur = byId.get(cur.parentId);
    return cur?.id ?? id;
  };

  const covered = new Set<string>();
  for (const l of lines) if (l.type === 'branch_summary' && l.fromId) covered.add(branchRoot(l.fromId));

  const branches = new Map<string, string[]>();
  for (const l of lines.slice(fromIndex)) {
    if (!l.id || active.has(l.id) || l.type !== 'message' || !ROLES.has(l.message?.role ?? '')) continue;
    const root = branchRoot(l.id);
    if (covered.has(root)) continue;
    const rows = branches.get(root) ?? [`### Ветка от ${l.timestamp?.slice(0, 16).replace('T', ' ')} UTC`];
    rows.push(...render(l));
    branches.set(root, rows);
  }

  // Лимит делится поровну: одна длинная ветка не должна вытеснить остальные
  const perBranch = Math.floor(maxChars / Math.max(branches.size, 1));
  return [...branches.values()]
    .map((rows) => {
      const text = rows.join('\n');
      return text.length > perBranch ? `${text.slice(0, perBranch)}${CUT}` : text;
    })
    .join('\n\n');
}

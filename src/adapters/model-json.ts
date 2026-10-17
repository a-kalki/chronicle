/**
 * Терпимый разбор JSON-ответа модели для агентов без вывода по схеме (pi).
 * Типичные сбои: ограждения markdown, потерянные закрывающие скобки, вложение knowledge/usage в work.
 * Результат всё равно проверяется схемой выжимки в finish.
 */

/** Закрывающие скобки, которых не хватает в конце текста (строки и экранирование учитываются) */
function missingClosers(text: string): string {
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return (inString ? '"' : '') + stack.reverse().join('');
}

/** knowledge/usage, оказавшиеся внутри work из-за потерянной скобки, — на верхний уровень */
function hoist(value: unknown): unknown {
  const o = value as { work?: Record<string, unknown> } & Record<string, unknown>;
  if (!o?.work || typeof o.work !== 'object') return value;
  const { knowledge, usage, ...work } = o.work;
  if (knowledge === undefined && usage === undefined) return value;
  return { ...o, work, knowledge: o.knowledge ?? knowledge, usage: o.usage ?? usage };
}

export function parseModelJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`в ответе нет JSON: ${text.slice(0, 300)}`);
  const whole = text.slice(start);
  const trimmed = text.slice(start, text.lastIndexOf('}') + 1);
  // Сначала строгий разбор (с обрезкой хвоста вроде ```), потом дополнение скобками по полному тексту:
  // обрезка по последней «}» могла бы разрезать строку со скобкой внутри
  for (const attempt of [trimmed, whole, whole + missingClosers(whole), trimmed + missingClosers(trimmed)]) {
    try {
      return hoist(JSON.parse(attempt));
    } catch {
      // следующий вариант
    }
  }
  throw new Error(`ответ не JSON: ${text.slice(0, 300)}`);
}

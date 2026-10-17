/** Нечёткое сравнение текстов записей без внешних зависимостей. */

const STOP_WORDS = new Set(
  (
    'и в во на с со по из к ко о об от до за для при без не ни но а или же ли что как это ' +
    'его её их все всё так уже через после перед между под над у бы то ' +
    'the a an of in on to for and or is are be by with from at as it this that'
  ).split(' '),
);

/** Длина основы: грубый стемминг усечением сводит словоформы («расширений»/«расширения»). */
const STEM_LENGTH = 5;

/** Набор основ значимых слов текста: camelCase разбивается, служебные слова и одиночные символы отбрасываются. */
export function stems(text: string): Set<string> {
  const words =
    text
      .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length > 1 && !STOP_WORDS.has(w)).map((w) => w.slice(0, STEM_LENGTH)));
}

/** Симметричная схожесть двух наборов основ (коэффициент Дайса), 0..1. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const s of a) if (b.has(s)) common++;
  return (2 * common) / (a.size + b.size);
}

/**
 * Релевантность текста запросу, 0..1: точное вхождение фразы (от 4 символов) — 1,
 * иначе доля основ запроса, найденных в тексте.
 */
export function queryScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (q.length >= 4 && text.toLowerCase().includes(q)) return 1;
  const qs = stems(q);
  if (qs.size === 0) return 0;
  const ts = stems(text);
  let found = 0;
  for (const s of qs) if (ts.has(s)) found++;
  return found / qs.size;
}

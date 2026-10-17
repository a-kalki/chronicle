/** Минимум данных сегмента для подсчёта активного времени. */
export interface ActivitySpan {
  startedAt: string;
  endedAt: string;
  source: 'log' | 'coarse';
  events: ReadonlyArray<{ at: string }>;
}

/**
 * Активное время сегмента: сумма промежутков между соседними событиями,
 * промежуток длиннее порога считается простоем и не учитывается.
 * Для coarse-активности событий нет — учитывается весь интервал.
 */
export function activeMs(span: ActivitySpan, idleGapMs: number): number {
  if (span.source === 'coarse') return Date.parse(span.endedAt) - Date.parse(span.startedAt);

  const times = span.events.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] as number) - (times[i - 1] as number);
    if (gap <= idleGapMs) total += gap;
  }
  return total;
}

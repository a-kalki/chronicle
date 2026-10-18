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

/** Промежуток времени, мс от эпохи; end > start */
export interface Interval {
  start: number;
  end: number;
}

/** Склеивает пересекающиеся и смежные интервалы; результат упорядочен */
function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/**
 * Активные интервалы сегмента: промежутки между соседними событиями не длиннее порога простоя,
 * склеенные подряд. Для coarse — весь интервал сегмента.
 */
export function activeIntervals(span: ActivitySpan, idleGapMs: number): Interval[] {
  if (span.source === 'coarse') return [{ start: Date.parse(span.startedAt), end: Date.parse(span.endedAt) }];

  const times = span.events.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
  const gaps: Interval[] = [];
  for (let i = 1; i < times.length; i++) {
    const start = times[i - 1] as number;
    const end = times[i] as number;
    if (end > start && end - start <= idleGapMs) gaps.push({ start, end });
  }
  return merge(gaps);
}

/** Длина объединения интервалов: пересечения не считаются дважды */
export function unionMs(intervals: readonly Interval[]): number {
  return merge(intervals).reduce((sum, i) => sum + i.end - i.start, 0);
}

/** Длина участков, где одновременно активны две и более сессии (по интервалам каждой сессии) */
export function parallelMs(sessions: readonly (readonly Interval[])[]): number {
  const edges = sessions
    .flatMap((s) =>
      merge(s).flatMap((i) => [
        { t: i.start, d: 1 },
        { t: i.end, d: -1 },
      ]),
    )
    // в одной точке сначала закрытия: смежные интервалы разных сессий не пересекаются
    .sort((a, b) => a.t - b.t || a.d - b.d);
  let active = 0;
  let total = 0;
  let prev = 0;
  for (const e of edges) {
    if (active >= 2) total += e.t - prev;
    active += e.d;
    prev = e.t;
  }
  return total;
}

/** Режет интервалы по моментам-границам (например, началам ходов) */
export function splitAt(intervals: readonly Interval[], boundaries: readonly number[]): Interval[] {
  const cuts = [...boundaries].sort((a, b) => a - b);
  return intervals.flatMap((i) => {
    const points = [i.start, ...cuts.filter((t) => t > i.start && t < i.end), i.end];
    return points.slice(1).map((end, k) => ({ start: points[k] as number, end }));
  });
}

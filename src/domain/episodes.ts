/**
 * Фокус ходов по эпизодам выжимки (docs/agent-contract.md, ExtractResult v2): эпизод размечает
 * диапазон номеров ходов. При пересечении побеждает более поздний эпизод; ход, не покрытый ни одним,
 * получает фокус соседнего — предыдущего, а в начале сегмента следующего.
 */

export interface EpisodeRange {
  from: number;
  to: number;
  focus: string;
}

export function turnFocuses(idxs: readonly number[], episodes: readonly EpisodeRange[]): (string | null)[] {
  const covered = idxs.map((idx) => {
    const last = episodes.findLast((e) => Math.min(e.from, e.to) <= idx && idx <= Math.max(e.from, e.to));
    return last?.focus ?? null;
  });
  const out = [...covered];
  for (let i = 1; i < out.length; i++) out[i] ??= out[i - 1] ?? null;
  for (let i = out.length - 2; i >= 0; i--) out[i] ??= out[i + 1] ?? null;
  return out;
}

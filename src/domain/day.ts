/** Локальный день человека: граница дня в проекциях берётся в часовом поясе из настроек. */

function parts(ms: number, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
}

/** Смещение пояса относительно UTC в момент ms */
function offsetMs(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const local = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return local - Math.floor(ms / 1000) * 1000;
}

/** Момент локальной полуночи даты YYYY-MM-DD */
function midnight(day: string, timeZone: string): number {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d);
  let t = naive - offsetMs(naive, timeZone);
  t = naive - offsetMs(t, timeZone);
  return t;
}

/** Локальные сутки даты: [from, to) в UTC */
export function dayBounds(day: string, timeZone: string): { from: string; to: string } {
  const from = midnight(day, timeZone);
  const next = new Date(from + 36 * 3_600_000);
  const p = parts(next.getTime(), timeZone);
  const nextDay = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { from: new Date(from).toISOString(), to: new Date(midnight(nextDay, timeZone)).toISOString() };
}

export function localDate(at: string | number, timeZone: string): string {
  const p = parts(typeof at === 'number' ? at : Date.parse(at), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTime(ms: number, timeZone: string): string {
  const p = parts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

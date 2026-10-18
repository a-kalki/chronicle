/**
 * Отчёт за день — проекция фактов (docs/data-and-api.md §2): время человека и по проектам с параллельным
 * временем, эпизоды (подряд идущие ходы с одним проектом и фокусом по всем сессиям), результаты и коммиты.
 */
import { activeIntervals, type Interval, parallelMs, splitAt, unionMs } from '../domain/activity.ts';
import { localTime } from '../domain/day.ts';
import type { Facts } from './facts.ts';
import type { StoredSegment, StoredTurn } from './store.ts';

interface Commit {
  hash: string;
  subject: string;
  at: string;
}

export interface EpisodeView {
  focus: string | null;
  start: number;
  end: number;
  ms: number;
  outcomes: string[];
  commits: Commit[];
}

export interface ProjectDay {
  id: string | null;
  name: string;
  ms: number;
  parallelMs: number;
  episodes: EpisodeView[];
  /** Коммиты проекта за день без эпизода (проект в этот день без активного времени) */
  commits: Commit[];
}

export interface DayReport {
  day: string;
  totalMs: number;
  parallelMs: number;
  projects: ProjectDay[];
  outcomes: number;
  commits: number;
}

/** Ход сегмента с его активными кусками за день */
interface TurnUnit {
  segment: StoredSegment;
  session: string;
  turn: StoredTurn;
  at: number;
  pieces: Interval[];
}

interface Episode {
  project: string | null;
  focus: string | null;
  units: TurnUnit[];
  view: EpisodeView;
}

const sessionKey = (s: StoredSegment) => `${s.agent}/${s.agentSessionId}`;

/** Ходы сегмента; сегмент без ходов (v1, coarse) — один ход: проект запуска, без фокуса */
function turnsOf(s: StoredSegment): StoredTurn[] {
  if (s.turns.length > 0) return [...s.turns].sort((a, b) => a.at.localeCompare(b.at));
  return [{ idx: 0, at: s.startedAt, projectId: s.launchProject, focus: null }];
}

function units(facts: Facts, idleGapMs: number): TurnUnit[] {
  const from = Date.parse(facts.from);
  const to = Date.parse(facts.to);
  return facts.segments.flatMap((segment) => {
    const turns = turnsOf(segment);
    const starts = turns.map((t) => Date.parse(t.at));
    const clipped = activeIntervals({ ...segment, source: segment.activitySource }, idleGapMs)
      .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
      .filter((i) => i.end > i.start);
    const out = turns.map((turn, k) => ({
      segment,
      session: sessionKey(segment),
      turn,
      // ход, начатый накануне, в этом дне начинается с полуночи
      at: Math.max(starts[k] as number, from),
      pieces: [] as Interval[],
    }));
    for (const piece of splitAt(clipped, starts)) {
      const k = starts.findLastIndex((t) => t <= piece.start);
      out[Math.max(k, 0)]?.pieces.push(piece);
    }
    return out.filter((u) => u.pieces.length > 0 || (u.at > from && u.at < to));
  });
}

function episodes(all: TurnUnit[]): Episode[] {
  const sorted = [...all].sort((a, b) => a.at - b.at);
  const out: Episode[] = [];
  for (const u of sorted) {
    const last = out[out.length - 1];
    if (last && last.project === u.turn.projectId && last.focus === u.turn.focus) last.units.push(u);
    else out.push({ project: u.turn.projectId, focus: u.turn.focus, units: [u], view: emptyView(u.turn.focus) });
  }
  for (const e of out) {
    const pieces = e.units.flatMap((u) => u.pieces);
    const edges = [...e.units.map((u) => u.at), ...pieces.flatMap((p) => [p.start, p.end])];
    e.view.start = Math.min(...pieces.map((p) => p.start), ...e.units.map((u) => u.at));
    e.view.end = Math.max(...edges);
    e.view.ms = unionMs(pieces);
  }
  return out;
}

const emptyView = (focus: string | null): EpisodeView => ({
  focus,
  start: 0,
  end: 0,
  ms: 0,
  outcomes: [],
  commits: [],
});

const bySession = (us: TurnUnit[]) => {
  const map = new Map<string, Interval[]>();
  for (const u of us) map.set(u.session, [...(map.get(u.session) ?? []), ...u.pieces]);
  return [...map.values()];
};

/** project — только этот проект: его время, эпизоды и коммиты */
export function dayReport(facts: Facts, opts: { day: string; idleGapMinutes?: number; project?: string }): DayReport {
  const all = units(facts, (opts.idleGapMinutes ?? facts.settings.idleGapMinutes) * 60_000);
  const eps = episodes(all);

  // результат — в эпизод своего сегмента с тем же проектом и фокусом
  let outcomes = 0;
  for (const s of facts.segments) {
    for (const o of s.outcomes) {
      const e = eps.findLast(
        (x) => x.project === o.projectId && x.focus === o.focus && x.units.some((u) => u.segment === s),
      );
      if (e && !e.view.outcomes.includes(o.text)) {
        e.view.outcomes.push(o.text);
        outcomes++;
      }
    }
  }

  // коммит учитывается один раз (проект + hash) — его могли прислать две параллельные сессии
  const commits = new Map<string, Commit & { projectId: string | null }>();
  const from = Date.parse(facts.from);
  const to = Date.parse(facts.to);
  for (const s of facts.segments) {
    for (const c of s.commits) {
      const t = Date.parse(c.at);
      if (t >= from && t < to) commits.set(`${c.projectId} ${c.hash}`, c);
    }
  }

  const names = new Map(facts.projects.map((p) => [p.id, p.name]));
  const projectIds = [...new Set([...eps.map((e) => e.project), ...[...commits.values()].map((c) => c.projectId)])];
  const projects = projectIds.map((id): ProjectDay => {
    const own = eps.filter((e) => e.project === id);
    const pieces = all.filter((u) => u.turn.projectId === id);
    const loose: Commit[] = [];
    for (const { projectId, ...c } of [...commits.values()].sort((a, b) => a.at.localeCompare(b.at))) {
      if (projectId !== id) continue;
      const t = Date.parse(c.at);
      const e = own.findLast((x) => x.view.start <= t) ?? own[0];
      (e?.view.commits ?? loose).push(c);
    }
    return {
      id,
      name: id === null ? 'без проекта' : (names.get(id) ?? id),
      ms: unionMs(pieces.flatMap((u) => u.pieces)),
      parallelMs: parallelMs(bySession(pieces)),
      episodes: own.map((e) => e.view),
      commits: loose,
    };
  });

  if (opts.project !== undefined) {
    const own = projects.find((p) => p.id === opts.project);
    return {
      day: opts.day,
      totalMs: own?.ms ?? 0,
      parallelMs: own?.parallelMs ?? 0,
      projects: own ? [own] : [],
      outcomes: own?.episodes.reduce((n, e) => n + e.outcomes.length, 0) ?? 0,
      commits: own ? own.commits.length + own.episodes.reduce((n, e) => n + e.commits.length, 0) : 0,
    };
  }
  return {
    day: opts.day,
    totalMs: unionMs(all.flatMap((u) => u.pieces)),
    parallelMs: parallelMs(bySession(all)),
    projects: projects.sort((a, b) => b.ms - a.ms),
    outcomes,
    commits: commits.size,
  };
}

const hours = (ms: number, parallel = 0) =>
  `${(ms / 3_600_000).toFixed(1)} ч${parallel > 0 ? ` (паралл. ${(parallel / 3_600_000).toFixed(1)} ч)` : ''}`;

export function formatDayReport(r: DayReport, timeZone: string): string {
  const lines = [`${r.day} — ${hours(r.totalMs, r.parallelMs)}`];
  for (const p of r.projects) {
    lines.push('', `${p.name} — ${hours(p.ms, p.parallelMs)}`);
    for (const e of p.episodes) {
      const span = `${localTime(e.start, timeZone)}–${localTime(e.end, timeZone)}`;
      lines.push(`  ${span} ${e.focus ?? '(без фокуса)'} — ${hours(e.ms)}`);
      for (const o of e.outcomes) lines.push(`    • ${o}`);
      for (const c of e.commits) lines.push(`    ${c.hash} ${c.subject}`);
    }
    if (p.commits.length > 0) {
      lines.push('  коммиты без активного времени:');
      for (const c of p.commits) lines.push(`    ${c.hash} ${c.subject}`);
    }
  }
  lines.push('', `Итого: ${hours(r.totalMs, r.parallelMs)}, результатов ${r.outcomes}, коммитов ${r.commits}`);
  return lines.join('\n');
}

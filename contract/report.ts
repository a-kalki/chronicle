/** Отчёт сегмента любой поддерживаемой версии: v2 — текущая, v1 — накопленный outbox старых клиентов. */
import * as v from 'valibot';
import * as V1 from './v1.ts';
import * as V2 from './v2.ts';

export type AnySessionReport = V1.SessionReport | V2.SessionReport;

export type ParsedReport = { ok: true; report: AnySessionReport } | { ok: false; issues: string[] };

export function parseSessionReport(input: unknown): ParsedReport {
  const isV2 = (input as { version?: unknown } | null)?.version === 2;
  const parsed = isV2 ? v.safeParse(V2.SessionReport, input) : v.safeParse(V1.SessionReport, input);
  if (parsed.success) return { ok: true, report: parsed.output };
  return { ok: false, issues: parsed.issues.map((i) => `${v.getDotPath(i) ?? '(корень)'}: ${i.message}`) };
}

#!/usr/bin/env bun
/** CLI chronicle — единственный путь доставки отчётов агентами (через outbox). */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { extractResultJsonSchema } from '../../contract/json-schema.ts';
import { SessionReport } from '../../contract/v1.ts';
import { AGENT_NAMES, getAdapter } from '../adapters/index.ts';
import type { KnowledgeEntry } from '../app/store.ts';
import { runFinish } from '../finish/finish.ts';
import { FinishState } from '../finish/state.ts';
import { ApiClient } from './api.ts';
import { type ClientConfig, loadClientConfig } from './config.ts';
import { type FlushResult, Outbox, type SendResult } from './outbox.ts';
import { detectProject } from './project.ts';

const USAGE = `Использование:
  chronicle search <текст ошибки или запрос> [--limit N]
  chronicle show <id>
  chronicle used <id> --helped yes|no|unknown
  chronicle report submit <файл|->
  chronicle outbox [list|flush]
  chronicle finish --agent <имя> (--session <id> | --hook) [--detach]
                                 итог сессии: выжимка агентом → отчёт сегмента
                                 --hook — ID сессии из JSON на stdin (session_id)
                                 --detach — в фоне, лог: <stateDir>/finish.log
  chronicle schema               JSON Schema выжимки (для --json-schema агентов)`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Флаги без значения */
const SWITCHES = new Set(['hook', 'detach']);

function splitFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('--')) positional.push(a);
    else if (SWITCHES.has(a.slice(2))) flags[a.slice(2)] = 'true';
    else flags[a.slice(2)] = args[++i] ?? '';
  }
  return { flags, positional };
}

const stamp = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function finish(config: ClientConfig, flags: Record<string, string>, send: (r: unknown) => Promise<SendResult>) {
  const agent = flags.agent ?? fail(`--agent: ${AGENT_NAMES.join(' | ')}`);
  const adapter = getAdapter(agent) ?? fail(`неизвестный агент «${agent}»; доступны: ${AGENT_NAMES.join(', ')}`);
  const sessionId = flags.hook
    ? ((JSON.parse(await Bun.stdin.text()) as { session_id?: string }).session_id ?? fail('hook: нет session_id'))
    : (flags.session ?? fail('--session <id> или --hook'));

  if (flags.detach) {
    mkdirSync(config.stateDir, { recursive: true });
    const logFd = openSync(join(config.stateDir, 'finish.log'), 'a');
    const child = spawn(process.execPath, [import.meta.path, 'finish', '--agent', agent, '--session', sessionId], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return console.log(`finish ${agent}/${sessionId} запущен в фоне`);
  }

  stamp(`finish ${agent}/${sessionId}`);
  const res = await runFinish({
    adapter,
    sessionId,
    host: config.host,
    outbox: new Outbox(config.outboxDir),
    send,
    state: new FinishState(join(config.stateDir, 'sessions')),
    extractModel: config.extractModel[agent],
    log: stamp,
  });
  stamp(`finish ${agent}/${sessionId}: ${JSON.stringify(res)}`);
  if (res.status === 'failed') process.exit(1);
}

function formatEntry(e: KnowledgeEntry): string {
  const lines = [`# ${e.title}`, '', `- **${e.id}** (${e.kind}, ${e.projectId ?? 'global'})`];
  if (e.symptoms.length > 0) lines.push('', '## Симптомы', ...e.symptoms.map((s) => `- \`${s}\``));
  lines.push('', '## Причина', e.cause, '', '## Решение', e.fix);
  if (e.tags.length > 0) lines.push('', `Теги: ${e.tags.join(', ')}`);
  return lines.join('\n');
}

const formatFlush = (r: FlushResult) => `доставлено: ${r.delivered}, отклонено: ${r.rejected}, в очереди: ${r.pending}`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'schema') return console.log(JSON.stringify(extractResultJsonSchema(), null, 2));
  // Неинтерактивный запуск агента для выжимки: его хуки завершения не должны снова запускать finish
  if (cmd === 'finish' && process.env.CHRONICLE_EXTRACT) return;

  const config = loadClientConfig(process.env);
  const api = new ApiClient(config.serverUrl, config.token);
  const outbox = new Outbox(config.outboxDir);
  const send = (r: unknown) => api.sendReport(r);
  const { flags, positional } = splitFlags(rest);

  if (cmd === 'finish') return finish(config, flags, send);

  if (cmd === 'report' && positional[0] === 'submit') {
    const source = positional[1] ?? fail(USAGE);
    const raw = source === '-' ? await Bun.stdin.text() : await Bun.file(source).text();
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      fail('отчёт: невалидный JSON');
    }
    const parsed = v.safeParse(SessionReport, input);
    if (!parsed.success) {
      fail(
        `отчёт не соответствует контракту:\n${parsed.issues.map((i) => `  ${v.getDotPath(i)}: ${i.message}`).join('\n')}`,
      );
    }
    outbox.enqueue(parsed.output);
    const res = await outbox.flush(send);
    console.log(formatFlush(res));
    if (res.rejected > 0) process.exit(1);
    return;
  }

  // list показывает очередь как есть — для диагностики
  if (cmd === 'outbox' && positional[0] === 'list') return console.log(outbox.list().join('\n') || 'Очередь пуста.');

  // Любая другая команда сначала пытается отправить накопленную очередь
  const flushed = await outbox.flush(send);
  if (cmd === 'outbox') return console.log(formatFlush(flushed));

  if (cmd === 'search') {
    const q = positional.join(' ').trim() || fail(USAGE);
    const project = { ...detectProject(process.cwd()), host: config.host };
    const hits = await api.search(q, project, Number(flags.limit ?? 10));
    if (hits.length === 0) return console.log('Ничего не найдено.');
    for (const h of hits) console.log(`• [${h.id}] (${h.kind}, ${h.scope}) ${h.title}`);
    return;
  }

  if (cmd === 'show') {
    const entry = await api.get(positional[0] ?? fail(USAGE));
    return entry ? console.log(formatEntry(entry)) : fail(`Запись ${positional[0]} не найдена`);
  }

  if (cmd === 'used') {
    const helped = { yes: true, no: false, unknown: null }[flags.helped ?? ''];
    if (helped === undefined) fail('--helped: yes|no|unknown');
    const ok = await api.usage(positional[0] ?? fail(USAGE), helped);
    return ok ? console.log('Отмечено.') : fail(`Запись ${positional[0]} не найдена`);
  }

  fail(USAGE);
}

main(process.argv.slice(2)).catch((e) => fail(e instanceof Error ? e.message : String(e)));

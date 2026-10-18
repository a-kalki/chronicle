#!/usr/bin/env bun
/** CLI chronicle — единственный путь доставки отчётов агентами (через outbox). */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { extractResultJsonSchema } from '../../contract/json-schema.ts';
import { parseSessionReport } from '../../contract/report.ts';
import { AGENT_NAMES, getAdapter } from '../adapters/index.ts';
import { formatEntry } from '../app/format.ts';
import { runFinish } from '../finish/finish.ts';
import { formatStatusLine, readLastFinish, writeLastFinish } from '../finish/last-result.ts';
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
  chronicle replay --agent <имя> --session <id>
                                 пересборка сессии целиком: разметка ходов заново, без знаний (replace)
  chronicle schema               JSON Schema выжимки (для --json-schema агентов)
  chronicle last --agent <имя>    последний итог finish агента (JSON, без сети) — для уведомлений
  chronicle statusline [--agent <имя>]
                                 строка статуса: последний итог сессии и очередь (без сети);
                                 читает JSON Claude Code со stdin (модель)`;

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

/** Строка статуса: ничего не отправляет и не падает — Claude Code вызывает её часто */
async function statusline(flags: Record<string, string>) {
  let model: string | undefined;
  if (!process.stdin.isTTY) {
    try {
      model = (JSON.parse(await Bun.stdin.text()) as { model?: { display_name?: string } }).model?.display_name;
    } catch {
      // stdin пуст или не JSON — без модели
    }
  }
  try {
    const config = loadClientConfig(process.env);
    const all = readLastFinish(config.stateDir);
    const last = flags.agent ? all[flags.agent] : Object.values(all).sort((a, b) => b.at.localeCompare(a.at))[0];
    console.log(
      formatStatusLine({ last, pending: new Outbox(config.outboxDir).list().length, now: new Date(), model }),
    );
  } catch {
    console.log(model ?? '');
  }
}

const stamp = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function finish(
  config: ClientConfig,
  flags: Record<string, string>,
  send: (r: unknown) => Promise<SendResult>,
  replay = false,
) {
  const agent = flags.agent ?? fail(`--agent: ${AGENT_NAMES.join(' | ')}`);
  const adapter = getAdapter(agent) ?? fail(`неизвестный агент «${agent}»; доступны: ${AGENT_NAMES.join(', ')}`);
  const sessionId =
    flags.hook && !replay
      ? ((JSON.parse(await Bun.stdin.text()) as { session_id?: string }).session_id ?? fail('hook: нет session_id'))
      : (flags.session ?? fail('--session <id> или --hook'));

  // Статус виден сразу: строка статуса Claude Code, уведомление pi (replay — ручная команда, статус не нужен)
  if (!replay) writeLastFinish(config.stateDir, { agent, sessionId, status: 'running', at: new Date().toISOString() });

  if (flags.detach && !replay) {
    mkdirSync(config.stateDir, { recursive: true });
    const logFd = openSync(join(config.stateDir, 'finish.log'), 'a');
    const child = spawn(process.execPath, [import.meta.path, 'finish', '--agent', agent, '--session', sessionId], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return console.log(`finish ${agent}/${sessionId} запущен в фоне`);
  }

  const what = replay ? 'replay' : 'finish';
  stamp(`${what} ${agent}/${sessionId}`);
  const res = await runFinish({
    replay,
    adapter,
    sessionId,
    host: config.host,
    outbox: new Outbox(config.outboxDir),
    send,
    state: new FinishState(join(config.stateDir, 'sessions')),
    extractModel: config.extractModel[agent],
    log: stamp,
  });
  stamp(`${what} ${agent}/${sessionId}: ${JSON.stringify(res)}`);
  if (!replay) {
    writeLastFinish(config.stateDir, {
      agent,
      sessionId,
      status: res.status,
      at: new Date().toISOString(),
      ...(res.status === 'reported' ? { summary: res.summary, knowledge: res.knowledge } : { reason: res.reason }),
    });
  }
  if (res.status === 'failed') process.exit(1);
}

const formatFlush = (r: FlushResult) => `доставлено: ${r.delivered}, отклонено: ${r.rejected}, в очереди: ${r.pending}`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'schema') return console.log(JSON.stringify(extractResultJsonSchema(), null, 2));
  // Неинтерактивный запуск агента для выжимки: его хуки завершения не должны снова запускать finish
  if (cmd === 'finish' && process.env.CHRONICLE_EXTRACT) return;

  if (cmd === 'statusline') return statusline(splitFlags(rest).flags);
  if (cmd === 'last') {
    const agent = splitFlags(rest).flags.agent ?? fail('--agent <имя>');
    return console.log(JSON.stringify(readLastFinish(loadClientConfig(process.env).stateDir)[agent] ?? null));
  }

  const config = loadClientConfig(process.env);
  const api = new ApiClient(config.serverUrl, config.token);
  const outbox = new Outbox(config.outboxDir);
  const send = (r: unknown) => api.sendReport(r);
  const { flags, positional } = splitFlags(rest);

  if (cmd === 'finish') return finish(config, flags, send);
  if (cmd === 'replay') return finish(config, flags, send, true);

  if (cmd === 'report' && positional[0] === 'submit') {
    const source = positional[1] ?? fail(USAGE);
    const raw = source === '-' ? await Bun.stdin.text() : await Bun.file(source).text();
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      fail('отчёт: невалидный JSON');
    }
    const parsed = parseSessionReport(input);
    if (!parsed.ok) fail(`отчёт не соответствует контракту:\n${parsed.issues.map((i) => `  ${i}`).join('\n')}`);
    outbox.enqueue(parsed.report);
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

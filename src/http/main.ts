#!/usr/bin/env bun
/** Запуск сервиса: bun src/http/main.ts [путь к chronicle.server.json] */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLlm } from '../infra/openai-llm.ts';
import { openStore } from '../infra/sqlite-store.ts';
import { parseServerConfig } from './config.ts';
import { startCurator } from './curator.ts';
import { createHandler } from './server.ts';

const configPath = process.argv[2] ?? process.env.CHRONICLE_CONFIG ?? './chronicle.server.json';
const file = existsSync(configPath) ? await Bun.file(configPath).json() : {};
const config = parseServerConfig(file, process.env);

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

mkdirSync(dirname(config.dbPath), { recursive: true });
const store = openStore(config.dbPath);
// Сессии, принятые до появления людей в модели, принадлежат единственному человеку, если он один
const persons = [...new Set(config.tokens.map((t) => t.person))];
if (persons.length === 1 && persons[0]) {
  const adopted = store.adoptOrphanSessions(persons[0]);
  if (adopted > 0) log(`сессий без человека отдано ${persons[0]}: ${adopted}`);
}
const curator = startCurator({
  store,
  llm: createLlm(config.llm, process.env),
  intervalMs: config.curateIntervalSeconds * 1000,
  archiveAfterDays: config.archiveAfterDays,
  log,
});
const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  fetch: createHandler({
    store,
    tokens: config.tokens,
    onCandidates: curator.kick,
    settings: { idleGapMinutes: config.idleGapMinutes, timezone: config.timezone },
  }),
});
log(`chronicle слушает ${server.url} (БД: ${config.dbPath}, LLM: ${config.llm.model})`);

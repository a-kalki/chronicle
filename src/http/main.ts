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
  fetch: createHandler({ store, tokens: config.tokens, onCandidates: curator.kick }),
});
log(`chronicle слушает ${server.url} (БД: ${config.dbPath}, LLM: ${config.llm.model})`);

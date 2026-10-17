#!/usr/bin/env bun
/** Запуск сервиса: bun src/http/main.ts [путь к chronicle.server.json] */
import { existsSync } from 'node:fs';
import { openStore } from '../infra/sqlite-store.ts';
import { parseServerConfig } from './config.ts';
import { createHandler } from './server.ts';

const configPath = process.argv[2] ?? process.env.CHRONICLE_CONFIG ?? './chronicle.server.json';
const file = existsSync(configPath) ? await Bun.file(configPath).json() : {};
const config = parseServerConfig(file, process.env);

const store = openStore(config.dbPath);
const server = Bun.serve({ port: config.port, fetch: createHandler({ store, tokens: config.tokens }) });
console.log(`chronicle слушает ${server.url} (БД: ${config.dbPath})`);

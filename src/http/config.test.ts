import { describe, expect, it } from 'bun:test';
import { parseServerConfig } from './config.ts';

describe('parseServerConfig', () => {
  it('подставляет значения по умолчанию', () => {
    const cfg = parseServerConfig({ tokens: [{ token: 't', person: 'nur' }] }, {});
    expect(cfg).toEqual({
      port: 4517,
      hostname: '127.0.0.1',
      dbPath: './data/chronicle.db',
      tokens: [{ token: 't', person: 'nur' }],
      idleGapMinutes: 30,
      archiveAfterDays: 120,
      curateIntervalSeconds: 300,
      timezone: 'Asia/Oral',
      llm: { model: 'deepseek/deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    });
  });

  it('токены из CHRONICLE_TOKENS (человек:токен) дополняют файл', () => {
    const cfg = parseServerConfig({ tokens: [{ token: 'a', person: 'nur' }] }, { CHRONICLE_TOKENS: 'nur:b, ali:c' });
    expect(cfg.tokens).toEqual([
      { token: 'a', person: 'nur' },
      { token: 'b', person: 'nur' },
      { token: 'c', person: 'ali' },
    ]);
  });

  it('токен без человека — ошибка запуска', () => {
    expect(() => parseServerConfig({}, { CHRONICLE_TOKENS: 'b' })).toThrow('человек:токен');
    expect(() => parseServerConfig({ tokens: ['t'] }, {})).toThrow();
  });

  it('без токенов сервис не запускается', () => {
    expect(() => parseServerConfig({}, {})).toThrow('токен');
  });

  it('отклоняет неверные значения', () => {
    expect(() => parseServerConfig({ tokens: [{ token: 't', person: 'nur' }], idleGapMinutes: -1 }, {})).toThrow();
  });
});

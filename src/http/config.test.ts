import { describe, expect, it } from 'bun:test';
import { parseServerConfig } from './config.ts';

describe('parseServerConfig', () => {
  it('подставляет значения по умолчанию', () => {
    const cfg = parseServerConfig({ tokens: ['t'] }, {});
    expect(cfg).toEqual({
      port: 4517,
      dbPath: './chronicle.db',
      tokens: ['t'],
      idleGapMinutes: 30,
      archiveAfterDays: 120,
      llm: { model: 'deepseek/deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    });
  });

  it('токены из CHRONICLE_TOKENS дополняют файл', () => {
    expect(parseServerConfig({ tokens: ['a'] }, { CHRONICLE_TOKENS: 'b, c' }).tokens).toEqual(['a', 'b', 'c']);
  });

  it('без токенов сервис не запускается', () => {
    expect(() => parseServerConfig({}, {})).toThrow('токен');
  });

  it('отклоняет неверные значения', () => {
    expect(() => parseServerConfig({ tokens: ['t'], idleGapMinutes: -1 }, {})).toThrow();
  });
});

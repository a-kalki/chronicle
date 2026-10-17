import { describe, expect, it } from 'bun:test';
import { createLlm } from './openai-llm.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

function capture(response: Response): { fetch: Fetch; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return response;
    },
  };
}

const ok = (content: string) => Response.json({ choices: [{ message: { content } }] });

describe('createLlm', () => {
  it('deepseek: адрес провайдера, модель без префикса, JSON-режим, ключ из env', async () => {
    const f = capture(ok('{"answer": 4}'));
    const llm = createLlm({ model: 'deepseek/deepseek-flash', apiKeyEnv: 'K' }, { K: 'key' }, f.fetch);
    expect(await llm.completeJson('sys', 'user')).toEqual({ answer: 4 });
    expect(f.calls[0]?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(f.calls[0]?.body).toMatchObject({ model: 'deepseek-flash', response_format: { type: 'json_object' } });
  });

  it('baseUrl из настроек важнее известного провайдера', async () => {
    const f = capture(ok('{}'));
    const llm = createLlm(
      { model: 'local/qwen', apiKeyEnv: 'K', baseUrl: 'http://127.0.0.1:8080/v1' },
      { K: 'key' },
      f.fetch,
    );
    await llm.completeJson('s', 'u');
    expect(f.calls[0]?.url).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('без ключа или с неизвестным провайдером без baseUrl — ошибка при создании', () => {
    expect(() => createLlm({ model: 'deepseek/deepseek-flash', apiKeyEnv: 'K' }, {})).toThrow('K');
    expect(() => createLlm({ model: 'acme/x', apiKeyEnv: 'K' }, { K: 'key' })).toThrow('acme');
  });

  it('HTTP-ошибка и не-JSON ответ — понятные исключения', async () => {
    const cfg = { model: 'deepseek/deepseek-flash', apiKeyEnv: 'K' };
    const failing = createLlm(cfg, { K: 'k' }, capture(new Response('busy', { status: 503 })).fetch);
    expect(failing.completeJson('s', 'u')).rejects.toThrow('503');
    const garbage = createLlm(cfg, { K: 'k' }, capture(ok('не json')).fetch);
    expect(garbage.completeJson('s', 'u')).rejects.toThrow('JSON');
  });
});

describe.if(process.env.CHRONICLE_LIVE_LLM === '1')('живой DeepSeek', () => {
  it('отвечает JSON-объектом', async () => {
    const llm = createLlm({ model: 'deepseek/deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }, process.env);
    const res = (await llm.completeJson('Ответь JSON-объектом {"sum": number}', '2+2')) as { sum: number };
    expect(res.sum).toBe(4);
  }, 60_000);
});

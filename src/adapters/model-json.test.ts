import { describe, expect, it } from 'bun:test';
import { parseModelJson } from './model-json.ts';

describe('parseModelJson', () => {
  it('берёт JSON-объект из ответа с ограждениями и текстом вокруг', () => {
    expect(parseModelJson('Вот:\n```json\n{"a": 1}\n```\n')).toEqual({ a: 1 });
  });

  it('дописывает недостающие закрывающие скобки, не путаясь в скобках внутри строк', () => {
    expect(parseModelJson('{"a": {"b": [1, 2], "c": "текст с } и ]"')).toEqual({
      a: { b: [1, 2], c: 'текст с } и ]' },
    });
  });

  it('выносит knowledge и usage, попавшие внутрь незакрытого work', () => {
    const broken = '{"work":{"summary":"s","items":[],"knowledge":[{"title":"t"}],"usage":[]}';
    expect(parseModelJson(broken)).toEqual({
      work: { summary: 's', items: [] },
      knowledge: [{ title: 't' }],
      usage: [],
    });
  });

  it('без JSON-объекта — исключение', () => {
    expect(() => parseModelJson('не могу')).toThrow('JSON');
  });
});

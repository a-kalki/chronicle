import { describe, expect, it } from 'bun:test';
import { queryScore, similarity, stems } from './similarity.ts';

describe('stems', () => {
  it('сводит словоформы к общей основе и отбрасывает служебные слова', () => {
    expect(stems('Автозагрузка расширений в Pi')).toEqual(stems('автозагрузка расширения pi'));
    expect(stems('и в на для the of')).toEqual(new Set());
  });

  it('разбивает camelCase и идентификаторы', () => {
    expect(stems('isoDateTime')).toEqual(new Set(['iso', 'date', 'time']));
    expect(stems('R-valibot-isoDateTime-format').has('valib')).toBe(true);
  });
});

describe('similarity', () => {
  it('единица для одинаковых наборов и ноль для непересекающихся', () => {
    expect(similarity(stems('tmux скроллинг'), stems('tmux скроллингом'))).toBe(1);
    expect(similarity(stems('biome json'), stems('telegram бот'))).toBe(0);
  });

  it('переформулировка одной проблемы похожа сильнее, чем разные проблемы', () => {
    const a = stems('Автозагрузка расширений в Pi из глобального каталога pi extensions settings');
    const b = stems('Автозагрузка расширений в Pi из глобальной директории pi extensions cli');
    const c = stems('Постоянный запрос разрешений на команды в агенте Pi permissions');
    expect(similarity(a, b)).toBeGreaterThan(0.6);
    expect(similarity(a, c)).toBeLessThan(0.3);
  });
});

describe('queryScore', () => {
  it('точное вхождение фразы — максимальный вес', () => {
    expect(queryScore('biome', 'рассинхронизация biome и json')).toBe(1);
  });

  it('находит запись по словам фразы в другом порядке и других формах', () => {
    expect(
      queryScore('ошибка форматтера biome json', 'рассинхронизация формата json и форматтером biome'),
    ).toBeGreaterThan(0.5);
    expect(queryScore('telegram бот', 'рассинхронизация формата json biome')).toBe(0);
  });

  it('находит запись по части camelCase-идентификатора (iso → isoDateTime)', () => {
    expect(
      queryScore('valibot iso дата', 'R-valibot-isoDateTime-format Valibot isoDateTime отклоняет Z'),
    ).toBeGreaterThan(0.5);
  });
});

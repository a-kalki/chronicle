import { describe, expect, it } from 'bun:test';
import { turnFocuses } from './episodes.ts';

const ep = (from: number, to: number, focus: string) => ({ from, to, focus });

describe('turnFocuses', () => {
  it('фокус хода — эпизод, покрывающий его номер', () => {
    expect(turnFocuses([1, 2, 3], [ep(1, 2, 'A'), ep(3, 3, 'B')])).toEqual(['A', 'A', 'B']);
  });

  it('при пересечении побеждает более поздний эпизод', () => {
    expect(turnFocuses([1, 2, 3], [ep(1, 3, 'A'), ep(2, 2, 'B')])).toEqual(['A', 'B', 'A']);
  });

  it('непокрытый ход получает фокус предыдущего хода, в начале — следующего', () => {
    expect(turnFocuses([4, 5, 6, 7], [ep(5, 5, 'A'), ep(7, 7, 'B')])).toEqual(['A', 'A', 'A', 'B']);
  });

  it('перевёрнутый диапазон читается как прямой; без эпизодов — null', () => {
    expect(turnFocuses([1, 2], [ep(2, 1, 'A')])).toEqual(['A', 'A']);
    expect(turnFocuses([1], [])).toEqual([null]);
  });
});

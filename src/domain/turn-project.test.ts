import { describe, expect, it } from 'bun:test';
import { turnProjects } from './turn-project.ts';

describe('turnProjects', () => {
  it('побеждает проект с наибольшим суммарным весом действий', () => {
    // правка в b (3) важнее двух чтений в a (1 + 1)
    const turns = [
      {
        actions: [
          { project: 'a', kind: 'read' as const },
          { project: 'a', kind: 'read' as const },
          { project: 'b', kind: 'edit' as const },
        ],
      },
    ];
    expect(turnProjects(turns, 'a')).toEqual(['b']);
  });

  it('shell весит больше чтения', () => {
    const turns = [
      {
        actions: [
          { project: 'a', kind: 'read' as const },
          { project: 'b', kind: 'shell' as const },
        ],
      },
    ];
    expect(turnProjects(turns, null)).toEqual(['b']);
  });

  it('ход без путей наследует предыдущий, первый — проект запуска', () => {
    const turns = [{ actions: [] }, { actions: [{ project: 'b', kind: 'edit' as const }] }, { actions: [] }];
    expect(turnProjects(turns, 'a')).toEqual(['a', 'b', 'b']);
  });

  it('пути вне git не дают проекта; без проектов и запуска вне git — null', () => {
    const turns = [{ actions: [{ project: null, kind: 'edit' as const }] }];
    expect(turnProjects(turns, null)).toEqual([null]);
    expect(turnProjects(turns, 'a')).toEqual(['a']);
  });

  it('при равном весе остаётся проект предыдущего хода', () => {
    const turns = [
      { actions: [{ project: 'b', kind: 'read' as const }] },
      {
        actions: [
          { project: 'a', kind: 'read' as const },
          { project: 'b', kind: 'read' as const },
        ],
      },
    ];
    expect(turnProjects(turns, 'a')).toEqual(['b', 'b']);
  });
});

/**
 * Проект хода (docs/data-and-api.md §2 Turn): по путям в вызовах инструментов хода.
 * Веса действий: правка файла — 3, shell (cd, git) — 2, чтение и поиск — 1; побеждает наибольший
 * суммарный вес. Ход без путей наследует проект предыдущего, первый — проект запуска.
 */

export type ActionKind = 'edit' | 'shell' | 'read';

export interface TurnAction {
  /** Проект пути (ключ); null — путь вне git-репозитория */
  project: string | null;
  kind: ActionKind;
}

const WEIGHTS: Record<ActionKind, number> = { edit: 3, shell: 2, read: 1 };

export function turnProjects(
  turns: readonly { actions: readonly TurnAction[] }[],
  launch: string | null,
): (string | null)[] {
  let prev = launch;
  return turns.map(({ actions }) => {
    const weights = new Map<string, number>();
    for (const a of actions) {
      if (a.project !== null) weights.set(a.project, (weights.get(a.project) ?? 0) + WEIGHTS[a.kind]);
    }
    const max = Math.max(0, ...weights.values());
    if (max > 0) {
      const leaders = [...weights].filter(([, w]) => w === max).map(([p]) => p);
      // при равенстве — проект предыдущего хода, иначе первый встретившийся
      prev = prev !== null && leaders.includes(prev) ? prev : (leaders[0] as string);
    }
    return prev;
  });
}

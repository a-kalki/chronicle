/**
 * Хуки agy вместо отсутствующего SessionEnd. SessionStart и Stop сообщают текущий диалог процесса agy:
 * смена диалога (/clear, /resume) — finish прошлого; сторож процесса agy — finish последнего на выходе.
 * Состояние: <dir>/<pid agy>.json. Кто удалил файл состояния, тот и делает finish — двойного не бывает.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgyHookDeps {
  /** Каталог состояний процессов agy */
  dir: string;
  isAlive(pid: number): boolean;
  /** Диалог человека, а не субагента; лога ещё нет — тоже нет (подхватит следующий хук) */
  isUserConversation(conversationId: string): boolean;
  /** Итог диалога в фоне */
  finish(conversationId: string): void;
  /** Запускает сторожа процесса agy, возвращает его pid */
  watch(agyPid: number): number;
}

interface ProcessState {
  conversationId: string;
  watcherPid: number;
}

const stateFile = (dir: string, pid: number) => join(dir, `${pid}.json`);

function read(path: string): ProcessState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProcessState;
  } catch {
    return null;
  }
}

/** Забирает состояние: удаление файла атомарно, второй желающий получит null */
function claim(path: string): ProcessState | null {
  const state = read(path);
  try {
    unlinkSync(path);
  } catch {
    return null;
  }
  return state;
}

function write(dir: string, pid: number, state: ProcessState): void {
  mkdirSync(dir, { recursive: true });
  const path = stateFile(dir, pid);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

/** Состояния процессов, у которых умерли и agy, и сторож (kill -9, перезагрузка) */
function sweepOrphans(deps: AgyHookDeps, exceptPid: number): void {
  if (!existsSync(deps.dir)) return;
  for (const name of readdirSync(deps.dir)) {
    const pid = Number(name.replace(/\.json$/, ''));
    if (!name.endsWith('.json') || !Number.isInteger(pid) || pid === exceptPid || deps.isAlive(pid)) continue;
    const path = join(deps.dir, name);
    const state = read(path);
    if (state && deps.isAlive(state.watcherPid)) continue;
    const claimed = claim(path);
    if (claimed) deps.finish(claimed.conversationId);
  }
}

export function onAgyHook(event: { conversationId: string; agyPid: number }, deps: AgyHookDeps): void {
  sweepOrphans(deps, event.agyPid);
  if (!deps.isUserConversation(event.conversationId)) return;

  const prev = read(stateFile(deps.dir, event.agyPid));
  if (prev?.conversationId === event.conversationId && deps.isAlive(prev.watcherPid)) return;
  if (prev && prev.conversationId !== event.conversationId) deps.finish(prev.conversationId);

  const watcherPid = prev && deps.isAlive(prev.watcherPid) ? prev.watcherPid : deps.watch(event.agyPid);
  write(deps.dir, event.agyPid, { conversationId: event.conversationId, watcherPid });
}

export function onAgyExit(agyPid: number, deps: AgyHookDeps): void {
  const state = claim(stateFile(deps.dir, agyPid));
  if (state) deps.finish(state.conversationId);
}

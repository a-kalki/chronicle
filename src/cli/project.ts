import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { normalizeRemote } from '../domain/remote.ts';

export interface DetectedProject {
  name: string;
  path: string;
  remote?: string;
}

function git(cwd: string, ...args: string[]): string | null {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
}

/** Настоящий хост SSH-алиаса из ~/.ssh/config (ssh -G — локально, без сети) */
export function sshHostname(host: string): string {
  const proc = Bun.spawnSync(['ssh', '-G', host], { stdout: 'pipe', stderr: 'ignore' });
  const line = proc.stdout
    .toString()
    .split('\n')
    .find((l) => l.startsWith('hostname '));
  return line?.slice('hostname '.length).trim() || host;
}

/** Нормализованный origin репо; SSH-алиас хоста раскрывается в настоящий хост */
function originOf(root: string, resolveHost: (host: string) => string): string | null {
  const origin = git(root, 'remote', 'get-url', 'origin');
  const remote = origin ? normalizeRemote(origin) : null;
  if (!origin || !remote || /^https?:\/\//i.test(origin)) return remote;
  const [host = '', ...rest] = remote.split('/');
  return [resolveHost(host).toLowerCase(), ...rest].join('/');
}

/** Имя проекта — по remote (каталог клона может называться иначе: ~ для linux-configs), иначе по каталогу */
function describeRepo(root: string, resolveHost: (host: string) => string): DetectedProject {
  const remote = originOf(root, resolveHost);
  return remote
    ? { name: remote.split('/').pop() || basename(root), path: root, remote }
    : { name: basename(root), path: root };
}

/**
 * Проект по cwd: корень git-репо и нормализованный origin; вне git — сам каталог.
 * SSH-алиас хоста (github-kalki → github.com) раскрывается: один репозиторий на разных машинах
 * может быть склонирован через разные алиасы, а идентичность проекта должна совпасть.
 */
export function detectProject(cwd: string, resolveHost: (host: string) => string = sshHostname): DetectedProject {
  return describeRepo(git(cwd, 'rev-parse', '--show-toplevel') ?? cwd, resolveHost);
}

/** Ближайший существующий каталог пути: файл может быть ещё не создан или уже удалён */
function existingDir(path: string): string {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return existsSync(dir) && !statSync(dir).isDirectory() ? dirname(dir) : dir;
}

/**
 * Git-репозиторий, которому принадлежит путь; null — путь вне git или игнорируется своим репо
 * (~/.pi, ~/.claude в репо настроек домашнего каталога) — такой путь проекта не образует.
 * Сам домашний каталог (запуск агента из ~, cd ~) о проекте ничего не говорит, даже если он репо:
 * из ~ запускают общие задачи и работу вне каталогов проектов. Файлы его репо (~/.bashrc) — говорят.
 */
export function findRepo(
  path: string,
  resolveHost: (host: string) => string = sshHostname,
  home: string = homedir(),
): DetectedProject | null {
  if (resolve(path) === resolve(home)) return null;
  const root = git(existingDir(path), 'rev-parse', '--show-toplevel');
  if (!root) return null;
  // отслеживаемые файлы check-ignore не считает игнорируемыми, даже если они подходят под шаблон
  // каталогу — завершающий /, иначе git не применит к нему шаблоны вида */
  const probe = existsSync(path) && statSync(path).isDirectory() ? `${path.replace(/\/+$/, '')}/` : path;
  if (path !== root && git(root, 'check-ignore', '-q', probe) !== null) return null;
  return describeRepo(root, resolveHost);
}

/** findRepo с запоминанием: у сессии сотни вызовов инструментов по одним и тем же путям */
export function repoResolver(find: (path: string) => DetectedProject | null = findRepo) {
  const cache = new Map<string, DetectedProject | null>();
  return (path: string): DetectedProject | null => {
    if (!cache.has(path)) cache.set(path, find(path));
    return cache.get(path) ?? null;
  };
}

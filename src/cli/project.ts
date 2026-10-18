import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
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

function describeRepo(root: string, resolveHost: (host: string) => string): DetectedProject {
  const remote = originOf(root, resolveHost);
  return remote ? { name: basename(root), path: root, remote } : { name: basename(root), path: root };
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

/** Git-репозиторий, которому принадлежит путь; null — путь вне git (проекта не образует) */
export function findRepo(path: string, resolveHost: (host: string) => string = sshHostname): DetectedProject | null {
  const root = git(existingDir(path), 'rev-parse', '--show-toplevel');
  return root ? describeRepo(root, resolveHost) : null;
}

/** findRepo с запоминанием по каталогу: у сессии сотни путей в нескольких репо */
export function repoResolver(find: (path: string) => DetectedProject | null = findRepo) {
  const byDir = new Map<string, DetectedProject | null>();
  return (path: string): DetectedProject | null => {
    const dir = existingDir(path);
    if (!byDir.has(dir)) byDir.set(dir, find(dir));
    return byDir.get(dir) ?? null;
  };
}

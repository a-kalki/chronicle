import { basename } from 'node:path';
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

/**
 * Проект по cwd: корень git-репо и нормализованный origin; вне git — сам каталог.
 * SSH-алиас хоста (github-kalki → github.com) раскрывается: один репозиторий на разных машинах
 * может быть склонирован через разные алиасы, а идентичность проекта должна совпасть.
 */
export function detectProject(cwd: string, resolveHost: (host: string) => string = sshHostname): DetectedProject {
  const path = git(cwd, 'rev-parse', '--show-toplevel') ?? cwd;
  const origin = git(path, 'remote', 'get-url', 'origin');
  let remote = origin ? normalizeRemote(origin) : null;
  if (origin && remote && !/^https?:\/\//i.test(origin)) {
    const [host = '', ...rest] = remote.split('/');
    remote = [resolveHost(host).toLowerCase(), ...rest].join('/');
  }
  return remote ? { name: basename(path), path, remote } : { name: basename(path), path };
}

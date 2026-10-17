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

/** Проект по cwd: корень git-репо и нормализованный origin; вне git — сам каталог. */
export function detectProject(cwd: string): DetectedProject {
  const path = git(cwd, 'rev-parse', '--show-toplevel') ?? cwd;
  const origin = git(path, 'remote', 'get-url', 'origin');
  const remote = origin ? normalizeRemote(origin) : null;
  return remote ? { name: basename(path), path, remote } : { name: basename(path), path };
}

/** Пути в вызовах инструментов агентов — по ним определяется проект хода (domain/turn-project.ts). */
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { PathAction } from '../finish/adapter.ts';

export function absPath(path: string, cwd: string): string {
  if (path === '~' || path.startsWith('~/')) return homedir() + path.slice(1);
  return isAbsolute(path) ? path : resolve(cwd, path);
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2');
const ARG = String.raw`("[^"]*"|'[^']*'|[^\s;&|)]+)`;
/** cd в начале команды или после ; && || | ( */
const CD = new RegExp(String.raw`(?:^|[;&|(])\s*cd\s+${ARG}`, 'g');
const GIT_C = new RegExp(String.raw`(?:^|[;&|(])\s*git\s+-C\s+${ARG}`, 'g');
const GIT = /(?:^|[;&|(])\s*git\s/;

/** Действия shell-команды: cd и git -C — их пути, git без них — cwd */
export function shellActions(command: string, cwd: string): PathAction[] {
  const paths = [...command.matchAll(CD), ...command.matchAll(GIT_C)].map((m) => absPath(unquote(m[1] ?? ''), cwd));
  if (paths.length === 0 && GIT.test(command)) paths.push(cwd);
  return [...new Set(paths)].map((path) => ({ path, kind: 'shell' }));
}

/** Реплика для списка ходов в промпте выжимки: одна строка, до 200 символов */
export function turnText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

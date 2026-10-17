/** Коммиты автора репо за интервал сегмента — проверяемое доказательство сделанной работы. */

export interface CollectedCommits {
  commits: { hash: string; subject: string; at: string }[];
  /** Изменённые файлы, относительно корня репо, без повторов */
  files: string[];
}

const SEP = '\x1f';

function git(cwd: string, ...args: string[]): string | null {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
  return proc.exitCode === 0 ? proc.stdout.toString() : null;
}

export function collectCommits(cwd: string, from: string, to: string): CollectedCommits {
  const email = git(cwd, 'config', 'user.email')?.trim();
  if (!email) return { commits: [], files: [] };

  const log = git(
    cwd,
    'log',
    '--all',
    '--reverse',
    `--author=${email}`,
    `--since=${from}`,
    `--until=${to}`,
    `--format=${SEP}%h${SEP}%s${SEP}%aI`,
    '--name-only',
  );
  if (!log) return { commits: [], files: [] };

  const commits: CollectedCommits['commits'] = [];
  const files = new Set<string>();
  for (const line of log.split('\n')) {
    if (line.startsWith(SEP)) {
      const [, hash = '', subject = '', at = ''] = line.split(SEP);
      commits.push({ hash, subject, at: new Date(at).toISOString() });
    } else if (line.trim()) {
      files.add(line.trim());
    }
  }
  return { commits, files: [...files].sort() };
}

/**
 * Нормализация git remote в идентичность проекта `host/owner/repo`:
 * один проект на ноутбуке и сервере клонирован по-разному (ssh, https), а идентичность одна.
 */
export function normalizeRemote(url: string): string | null {
  const raw = url.trim();
  // scp-like: git@host:owner/repo.git
  const scp = raw.match(/^[\w.-]+@([\w.-]+):(?!\d+\/)(.+)$/);
  // URL: https://host/owner/repo, ssh://git@host:22/owner/repo
  const full = raw.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/i);
  const match = scp ?? full;
  if (!match?.[1] || !match[2]) return null;

  const path = match[2].replace(/\/+$/, '').replace(/\.git$/, '');
  if (!path.includes('/')) return null;
  return `${match[1].toLowerCase()}/${path.toLowerCase()}`;
}

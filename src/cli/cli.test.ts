import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../http/server.ts';
import { openStore } from '../infra/sqlite-store.ts';
import { detectProject, findRepo, repoResolver } from './project.ts';

const CLI = join(import.meta.dir, 'main.ts');
const root = mkdtempSync(join(tmpdir(), 'chronicle-cli-'));
const repo = join(root, 'u7-school');
const outbox = join(root, 'outbox');
const store = openStore(':memory:');
let server: ReturnType<typeof Bun.serve>;

function git(...args: string[]) {
  Bun.spawnSync(['git', ...args], { cwd: repo });
}

// Асинхронный запуск: spawnSync заблокировал бы event loop, и сервер в этом же процессе не ответил бы
async function cli(args: string[], opts: { url?: string; stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      CHRONICLE_URL: opts.url ?? server.url.href,
      CHRONICLE_TOKEN: 'secret',
      CHRONICLE_HOST: 'laptop',
      CHRONICLE_OUTBOX: outbox,
      CHRONICLE_CONFIG: join(root, 'no-config.json'),
      CHRONICLE_STATE: join(root, 'state'),
      ...opts.env,
    },
    stdin: opts.stdin ? Buffer.from(opts.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const report = (seq: number) =>
  JSON.stringify({
    version: 1,
    session: {
      agent: 'pi',
      id: 's-1',
      host: 'laptop',
      seq,
      startedAt: '2026-10-17T05:00:00.000Z',
      endedAt: '2026-10-17T06:00:00.000Z',
    },
    project: { remote: 'github.com/nurgeo/u7-school', name: 'u7-school', path: repo },
    activity: { source: 'coarse', events: [] },
    work: { summary: 'Сделано', items: [], commits: [], files: [] },
    knowledge: [],
    usage: [],
  });

beforeAll(() => {
  Bun.spawnSync(['mkdir', '-p', repo]);
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:NurGeo/u7-school.git');
  server = Bun.serve({ port: 0, fetch: createHandler({ store, tokens: [{ token: 'secret', person: 'nur' }] }) });
  store.createProject({ name: 'u7-school', host: 'laptop', path: repo, remote: 'github.com/nurgeo/u7-school' });
  store.insertEntry({
    id: 'K-ssh',
    projectId: null,
    kind: 'trap',
    title: 'ssh-деплой: bun не найден',
    symptoms: ['bun: command not found'],
    cause: 'неинтерактивная сессия без PATH',
    fix: 'export PATH=$HOME/.bun/bin:$PATH',
    tags: ['ssh', 'deploy'],
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe('detectProject', () => {
  it('берёт корень репо, имя и нормализованный origin', () => {
    expect(detectProject(repo)).toEqual({ name: 'u7-school', path: repo, remote: 'github.com/nurgeo/u7-school' });
  });

  it('SSH-алиас хоста в origin раскрывается в настоящий хост', () => {
    git('remote', 'set-url', 'origin', 'github-kalki:a-kalki/u7-school.git');
    const resolve = (host: string) => (host === 'github-kalki' ? 'github.com' : host);
    expect(detectProject(repo, resolve).remote).toBe('github.com/a-kalki/u7-school');
    git('remote', 'set-url', 'origin', 'git@github.com:NurGeo/u7-school.git');
  });

  it('вне git — текущий каталог без remote', () => {
    expect(detectProject(root)).toEqual({ name: root.split('/').pop() as string, path: root });
  });
});

describe('findRepo', () => {
  it('файл внутри репо (даже ещё не созданный) — корень репо и remote', () => {
    const expected = { name: 'u7-school', path: repo, remote: 'github.com/nurgeo/u7-school' };
    expect(findRepo(join(repo, 'src/new/file.ts'))).toEqual(expected);
    expect(findRepo(repo)).toEqual(expected);
  });

  it('вне git — null', () => {
    expect(findRepo(join(root, 'notes.md'))).toBeNull();
  });

  it('путь, игнорируемый своим репо (как ~/.pi в репо домашнего каталога), проекта не даёт', () => {
    writeFileSync(join(repo, '.gitignore'), '.*\n!.gitignore\n');
    expect(findRepo(join(repo, '.pi/agent/AGENTS.md'))).toBeNull();
    expect(findRepo(join(repo, 'src/a.ts'))?.path).toBe(repo);
    rmSync(join(repo, '.gitignore'));
  });

  it('repoResolver запоминает ответ по пути', () => {
    let calls = 0;
    const resolve = repoResolver((p) => {
      calls++;
      return findRepo(p);
    });
    resolve(join(repo, 'a.ts'));
    resolve(join(repo, 'a.ts'));
    expect(resolve(join(repo, 'a.ts'))?.path).toBe(repo);
    expect(calls).toBe(1);
  });
});

describe('CLI chronicle', () => {
  it('search находит запись по тексту ошибки, show выводит её целиком', async () => {
    const search = await cli(['search', 'bun:', 'command', 'not', 'found']);
    expect(search.code).toBe(0);
    expect(search.out).toContain('[K-ssh]');

    const show = await cli(['show', 'K-ssh']);
    expect(show.out).toContain('export PATH=$HOME/.bun/bin:$PATH');
  });

  it('used отмечает пользу', async () => {
    expect((await cli(['used', 'K-ssh', '--helped', 'yes'])).code).toBe(0);
    expect((await cli(['used', 'K-none', '--helped', 'yes'])).code).toBe(1);
  });

  it('report submit из файла и stdin доставляет отчёт, outbox пуст', async () => {
    const file = join(root, 'r1.json');
    writeFileSync(file, report(1));
    const fromFile = await cli(['report', 'submit', file]);
    expect(fromFile.code).toBe(0);
    expect(fromFile.out).toContain('доставлено: 1');

    expect((await cli(['report', 'submit', '-'], { stdin: report(2) })).code).toBe(0);
    expect(readdirSync(outbox).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('невалидный отчёт отклоняется локально, в очередь не попадает', async () => {
    const res = await cli(['report', 'submit', '-'], { stdin: '{"version": 1}' });
    expect(res.code).toBe(1);
    expect(res.err).toContain('session');
  });

  it('при недоступном сервере отчёт остаётся в очереди и уходит при следующем вызове', async () => {
    const down = await cli(['report', 'submit', '-'], { stdin: report(3), url: 'http://127.0.0.1:1' });
    expect(down.code).toBe(0);
    expect(down.out).toContain('в очереди: 1');

    const list = await cli(['outbox', 'list']);
    expect(list.out).toContain('pi__s-1__000003.json');

    // любой вызов при доступном сервере сначала отправляет очередь
    await cli(['search', 'ssh']);
    expect(readdirSync(outbox).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('schema выводит JSON Schema выжимки', async () => {
    const res = await cli(['schema']);
    expect(JSON.parse(res.out).required).toContain('work');
  });

  it('finish внутри выжимки (CHRONICLE_EXTRACT) молча ничего не делает', async () => {
    const res = await cli(['finish', '--agent', 'claude-code', '--session', 'x'], { env: { CHRONICLE_EXTRACT: '1' } });
    expect(res).toEqual({ code: 0, out: '', err: '' });
  });

  it('finish с неизвестным агентом — ошибка со списком доступных', async () => {
    const res = await cli(['finish', '--agent', 'nope', '--session', 'x']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('claude-code');
  });

  it('finish --hook берёт session_id из stdin; неизвестная сессия — пропуск', async () => {
    const res = await cli(['finish', '--agent', 'claude-code', '--hook'], {
      stdin: JSON.stringify({ session_id: 'no-such-session', reason: 'clear' }),
    });
    expect(res.code).toBe(0);
    expect(res.out).toContain('лог сессии не найден');

    // итог записан для строки статуса и уведомлений
    const last = JSON.parse(readFileSync(join(root, 'state', 'last-finish.json'), 'utf8'));
    expect(last['claude-code']).toMatchObject({ sessionId: 'no-such-session', status: 'skipped' });

    const line = await cli(['statusline'], { stdin: JSON.stringify({ model: { display_name: 'Opus 5.5' } }) });
    expect(line.out).toContain('Opus 5.5 · chronicle · ');
    expect(line.out).toContain('пропуск: лог сессии не найден');

    const lastRes = await cli(['last', '--agent', 'claude-code']);
    expect(JSON.parse(lastRes.out)).toMatchObject({ sessionId: 'no-such-session', status: 'skipped' });
    expect(JSON.parse((await cli(['last', '--agent', 'pi'])).out)).toBeNull();
  });

  it('statusline без настроек клиента не падает и показывает только модель', async () => {
    const res = await cli(['statusline'], {
      stdin: JSON.stringify({ model: { display_name: 'Opus 5.5' } }),
      env: { CHRONICLE_URL: '', CHRONICLE_TOKEN: '' },
    });
    expect(res).toMatchObject({ code: 0, out: 'Opus 5.5\n' });
  });
});

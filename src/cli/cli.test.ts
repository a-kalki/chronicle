import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../http/server.ts';
import { openStore } from '../infra/sqlite-store.ts';
import { detectProject } from './project.ts';

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
async function cli(args: string[], opts: { url?: string; stdin?: string } = {}) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      CHRONICLE_URL: opts.url ?? server.url.href,
      CHRONICLE_TOKEN: 'secret',
      CHRONICLE_HOST: 'laptop',
      CHRONICLE_OUTBOX: outbox,
      CHRONICLE_CONFIG: join(root, 'no-config.json'),
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
  server = Bun.serve({ port: 0, fetch: createHandler({ store, tokens: ['secret'] }) });
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

  it('вне git — текущий каталог без remote', () => {
    expect(detectProject(root)).toEqual({ name: root.split('/').pop() as string, path: root });
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
});

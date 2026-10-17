/**
 * Расширение pi для chronicle: /finish — итог сессии в фоне и сразу новая чистая сессия
 * (/finish exit — с выходом). Вся работа — в `chronicle finish` (см. docs/agent-contract.md).
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/** Минимум API pi, которым пользуется расширение */
interface PiUi {
  notify?: (message: string, level: 'info' | 'warning' | 'error') => void;
}

interface PiContext {
  ui: PiUi;
  sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
  newSession?: (options: { withSession: (ctx: PiContext) => Promise<void> }) => Promise<void>;
  shutdown?: () => Promise<void>;
}

interface PiApi {
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: PiContext) => Promise<void> },
  ): void;
}

function sessionIdOf(ctx: PiContext): string | undefined {
  const id = ctx.sessionManager?.getSessionId?.();
  if (id) return id;
  // Файл сессии: <время>_<uuid>.jsonl
  const file = ctx.sessionManager?.getSessionFile?.();
  return file ? basename(file, '.jsonl').split('_').pop() : undefined;
}

interface LastFinish {
  sessionId: string;
  status: 'running' | 'reported' | 'skipped' | 'failed';
  summary?: string;
  knowledge?: number;
  reason?: string;
}

const POLL_MS = 3000;
/** Дольше выжимка не идёт (таймаут агента — 10 мин, плюс повтор) */
const POLL_LIMIT_MS = 25 * 60_000;

function lastFinish(): LastFinish | null {
  const res = spawnSync('chronicle', ['last', '--agent', 'pi'], { encoding: 'utf8' });
  try {
    return res.status === 0 ? (JSON.parse(res.stdout) as LastFinish | null) : null;
  } catch {
    return null;
  }
}

/** Ждёт итог фонового finish этой сессии и сообщает о нём в новой сессии */
function notifyWhenDone(sessionId: string, ui: PiUi) {
  const started = Date.now();
  const timer = setInterval(() => {
    const last = lastFinish();
    const done = last?.sessionId === sessionId && last.status !== 'running';
    if (!done && Date.now() - started < POLL_LIMIT_MS) return;
    clearInterval(timer);
    if (!done || !last) ui.notify?.('chronicle: итог прошлой сессии так и не пришёл — см. finish.log', 'warning');
    else if (last.status === 'reported') {
      const knowledge = last.knowledge ? `, +${last.knowledge} в базу знаний` : '';
      ui.notify?.(`✓ Итог прошлой сессии отправлен: ${last.summary}${knowledge}`, 'info');
    } else if (last.status === 'skipped') ui.notify?.(`Итог прошлой сессии не отправлен: ${last.reason}`, 'info');
    else ui.notify?.(`✖ Итог прошлой сессии не получен: ${last.reason} (см. finish.log)`, 'error');
  }, POLL_MS);
}

export default function chronicleFinish(pi: PiApi) {
  pi.registerCommand('finish', {
    description: 'Итог сессии в chronicle (в фоне) и новая чистая сессия; /finish exit — с выходом',
    handler: async (args, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) {
        ctx.ui.notify?.('chronicle: не удалось определить ID сессии', 'error');
        return;
      }

      // --detach возвращается сразу: выжимка и отправка идут отдельным процессом
      const res = spawnSync('chronicle', ['finish', '--agent', 'pi', '--session', sessionId, '--detach'], {
        encoding: 'utf8',
      });
      if (res.status !== 0) {
        ctx.ui.notify?.(`chronicle: ${(res.stderr || res.error?.message || 'ошибка запуска').trim()}`, 'error');
        return;
      }

      if (/^(exit|quit)\b/i.test(args.trim())) {
        ctx.ui.notify?.('Итог сессии формируется в фоне. До встречи!', 'info');
        await ctx.shutdown?.();
        return;
      }
      await ctx.newSession?.({
        withSession: async (next) => {
          next.ui.notify?.('Итог прошлой сессии формируется в фоне', 'info');
          notifyWhenDone(sessionId, next.ui);
        },
      });
    },
  });
}

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
        withSession: async (next) => next.ui.notify?.('Итог прошлой сессии формируется в фоне', 'info'),
      });
    },
  });
}

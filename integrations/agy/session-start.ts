#!/usr/bin/env bun
/**
 * Хук SessionStart для agy: сообщает в новой сессии об итоге предыдущей
 * (точно так же, как уведомление в pi и строка статуса в Claude Code).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type LastFinish, readLastFinish } from '../../src/finish/last-result.ts';

const POLL_INTERVAL_MS = 1000;
const WAIT_RUNNING_LIMIT_MS = 10_000;
const STALE_LIMIT_MS = 24 * 3_600_000;

const stateDir = process.env.CHRONICLE_STATE ?? join(homedir(), '.local/state/chronicle');

async function main() {
  let conversationId = '';
  try {
    const raw = await Bun.stdin.text();
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as { conversationId?: string };
      conversationId = parsed.conversationId ?? '';
    }
  } catch {
    // игнорируем ошибку парсинга stdin
  }

  let last: LastFinish | undefined = readLastFinish(stateDir).agy;

  // Если прошлый итог всё ещё формируется в фоне — подождём несколько секунд
  if (last?.status === 'running' && last.sessionId !== conversationId) {
    const start = Date.now();
    while (Date.now() - start < WAIT_RUNNING_LIMIT_MS) {
      await Bun.sleep(POLL_INTERVAL_MS);
      last = readLastFinish(stateDir).agy;
      if (last?.status !== 'running') break;
    }
  }

  if (!last || last.sessionId === conversationId) {
    console.log(JSON.stringify({ injectSteps: [] }));
    return;
  }

  // Не показываем слишком старые итоги
  const age = Date.now() - Date.parse(last.at);
  if (Number.isNaN(age) || age > STALE_LIMIT_MS) {
    console.log(JSON.stringify({ injectSteps: [] }));
    return;
  }

  let text = '';
  if (last.status === 'reported') {
    const knowledge = last.knowledge ? `, +${last.knowledge} в базу знаний` : '';
    text = `✓ Итог прошлой сессии chronicle: ${last.summary ?? ''}${knowledge}`;
  } else if (last.status === 'skipped') {
    text = `chronicle: итог прошлой сессии пропущен (${last.reason ?? 'тривиальный сегмент'})`;
  } else if (last.status === 'failed') {
    text = `✖ chronicle: ошибка формирования итога прошлой сессии: ${last.reason ?? 'см. finish.log'}`;
  } else if (last.status === 'running') {
    text = 'chronicle: ⏳ итог прошлой сессии всё ещё формируется в фоне...';
  }

  if (!text) {
    console.log(JSON.stringify({ injectSteps: [] }));
    return;
  }

  console.log(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: text,
          },
        },
      ],
    }),
  );
}

main().catch(() => {
  console.log(JSON.stringify({ injectSteps: [] }));
});

/** Фоновое курирование в процессе сервиса: по сигналу после отчёта и по таймеру; проходы не пересекаются. */
import { archiveStale, curatePending } from '../app/curate.ts';
import type { Llm } from '../app/llm.ts';
import type { Store } from '../app/store.ts';

export interface CuratorDeps {
  store: Store;
  llm: Llm;
  intervalMs: number;
  archiveAfterDays: number;
  log: (message: string) => void;
}

export interface Curator {
  /** Запросить проход (если идёт — будет ещё один после него) */
  kick(): void;
  /** Дождаться окончания текущих проходов */
  idle(): Promise<void>;
  stop(): void;
}

const DAY_MS = 86_400_000;

export function startCurator({ store, llm, intervalMs, archiveAfterDays, log }: CuratorDeps): Curator {
  let running: Promise<void> | null = null;
  let again = false;
  let lastArchive = 0;

  async function pass() {
    const res = await curatePending(store, llm);
    if (res.created + res.merged + res.discarded + res.failed > 0) log(`курирование: ${JSON.stringify(res)}`);
    if (Date.now() - lastArchive >= DAY_MS) {
      const archived = archiveStale(store, archiveAfterDays);
      if (archived.length > 0) log(`в архив: ${archived.join(', ')}`);
      lastArchive = Date.now();
    }
  }

  function kick() {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await pass();
        } catch (e) {
          log(`курирование упало: ${e instanceof Error ? e.message : String(e)}`);
        }
      } while (again);
      running = null;
    })();
  }

  const timer = setInterval(kick, intervalMs);
  kick();

  return {
    kick,
    async idle() {
      while (running) await running;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

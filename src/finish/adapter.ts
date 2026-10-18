/** Контракт адаптера агента для `chronicle finish` (см. docs/agent-contract.md). */

/**
 * Форк сессии копирует старую историю с исходными метками времени. События старше начала самого лога
 * (с этим запасом: реплика пользователя пишется чуть раньше создания файла) — скопированные, их не учитываем.
 */
export const COPIED_HISTORY_SLACK_MS = 60_000;

/** Действие инструмента с путём: правка, shell (cd, git), чтение и поиск */
export interface PathAction {
  /** Абсолютный путь */
  path: string;
  kind: 'edit' | 'shell' | 'read';
}

/** Ход: реплика человека и работа агента до следующей реплики */
export interface SessionTurn {
  at: string;
  /** Реплика, одной строкой до 200 символов — для списка ходов в промпте выжимки */
  text: string;
  actions: PathAction[];
}

export interface SessionRead {
  /** Рабочий каталог сессии — по нему определяется проект */
  cwd: string;
  source: 'log' | 'coarse';
  /** События после watermark (для coarse — пусто) */
  events: { at: string; actor: 'user' | 'agent' }[];
  /** Ходы после watermark; работа агента до первой новой реплики относится к первому ходу */
  turns: SessionTurn[];
  /** Интервал для coarse-активности */
  startedAt?: string;
  endedAt?: string;
  /** Новая позиция в логе; сохраняется после успешной постановки отчёта в очередь */
  watermark: unknown;
}

export interface ExtractOptions {
  /** Дешёвая модель агента */
  model: string;
  /** Общий промпт выжимки (prompts/extract.md) */
  prompt: string;
  /** JSON Schema выжимки */
  schema: object;
  /** Watermark начала сегмента (null — первый сегмент): адаптер может дополнить промпт тем, чего нет в форке */
  watermark: unknown | null;
  cwd: string;
}

export interface AgentAdapter {
  name: string;
  defaultExtractModel: string;
  /** null — лог сессии не найден */
  readSession(sessionId: string, watermark: unknown | null): SessionRead | null;
  /** Неинтерактивный запуск агента на копии сессии; возвращает сырой JSON выжимки */
  extract(sessionId: string, options: ExtractOptions): Promise<unknown>;
}

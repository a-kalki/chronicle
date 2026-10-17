/**
 * Локальная очередь отчётов: гарантирует, что отчёт не потеряется при недоступном сервере.
 * Файл на сегмент (повторная постановка того же сегмента перезаписывает файл);
 * запись атомарная через временный файл и rename.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SendResult =
  | { kind: 'delivered'; body: unknown }
  | { kind: 'rejected'; issues: string[] }
  | { kind: 'unavailable'; error: string };

export interface FlushResult {
  delivered: number;
  rejected: number;
  pending: number;
}

interface SegmentKey {
  session: { agent: string; id: string; seq: number };
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');

export class Outbox {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  enqueue(report: unknown): string {
    const { session } = report as SegmentKey;
    // Ведущие нули: лексикографический порядок файлов = порядок сегментов
    const name = `${safe(session.agent)}__${safe(session.id)}__${String(session.seq).padStart(6, '0')}.json`;
    const tmp = join(this.dir, `.${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(report));
    renameSync(tmp, join(this.dir, name));
    return name;
  }

  list(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();
  }

  /** Отправляет очередь по порядку; при недоступности сервера останавливается. */
  async flush(send: (report: unknown) => Promise<SendResult>): Promise<FlushResult> {
    const res: FlushResult = { delivered: 0, rejected: 0, pending: 0 };
    const files = this.list();
    for (const [i, name] of files.entries()) {
      const path = join(this.dir, name);
      const result = await send(JSON.parse(readFileSync(path, 'utf8')));
      if (result.kind === 'unavailable') {
        res.pending = files.length - i;
        break;
      }
      if (result.kind === 'rejected') {
        const rejectedDir = join(this.dir, 'rejected');
        mkdirSync(rejectedDir, { recursive: true });
        renameSync(path, join(rejectedDir, name));
        writeFileSync(
          join(rejectedDir, name.replace(/\.json$/, '.issues.json')),
          JSON.stringify(result.issues, null, 2),
        );
        res.rejected++;
        continue;
      }
      rmSync(path);
      res.delivered++;
    }
    return res;
  }
}

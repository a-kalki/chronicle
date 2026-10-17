import { beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox, type SendResult } from './outbox.ts';

const report = (seq: number) => ({ version: 1, session: { agent: 'pi', id: 's/1', seq } });

describe('Outbox', () => {
  let dir: string;
  let outbox: Outbox;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chronicle-outbox-'));
    outbox = new Outbox(dir);
  });

  it('кладёт отчёт в очередь под безопасным именем и не дублирует тот же сегмент', () => {
    outbox.enqueue(report(1));
    outbox.enqueue(report(1));
    outbox.enqueue(report(2));
    expect(outbox.list()).toHaveLength(2);
    expect(readdirSync(dir).every((f) => !f.includes('/'))).toBe(true);
  });

  it('flush отправляет по порядку и удаляет доставленные', async () => {
    outbox.enqueue(report(2));
    outbox.enqueue(report(1));
    const sent: number[] = [];
    const res = await outbox.flush(async (r) => {
      sent.push((r as ReturnType<typeof report>).session.seq);
      return { kind: 'delivered', body: {} };
    });
    expect(sent).toEqual([1, 2]);
    expect(res).toEqual({ delivered: 2, rejected: 0, pending: 0 });
    expect(outbox.list()).toHaveLength(0);
  });

  it('при недоступном сервере останавливается и сохраняет очередь', async () => {
    outbox.enqueue(report(1));
    outbox.enqueue(report(2));
    let calls = 0;
    const res = await outbox.flush(async (): Promise<SendResult> => {
      calls++;
      return { kind: 'unavailable', error: 'ECONNREFUSED' };
    });
    expect(calls).toBe(1);
    expect(res).toEqual({ delivered: 0, rejected: 0, pending: 2 });
  });

  it('отклонённый по контракту отчёт уходит в rejected с причинами и не блокирует очередь', async () => {
    outbox.enqueue(report(1));
    outbox.enqueue(report(2));
    const res = await outbox.flush(async (r) =>
      (r as ReturnType<typeof report>).session.seq === 1
        ? { kind: 'rejected', issues: ['version: неверно'] }
        : { kind: 'delivered', body: {} },
    );
    expect(res).toEqual({ delivered: 1, rejected: 1, pending: 0 });
    const rejected = readdirSync(join(dir, 'rejected'));
    expect(rejected.some((f) => f.endsWith('.issues.json'))).toBe(true);
    expect(existsSync(join(dir, 'rejected'))).toBe(true);
  });
});

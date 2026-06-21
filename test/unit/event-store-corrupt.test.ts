/**
 * Regression test for audit finding C3 (area 8): a single corrupt/garbage event row
 * must NOT poison the read path and crash the orchestrator + watcher. Reads must skip
 * the bad row, return the good ones, and never throw a raw SyntaxError/ZodError.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore } from '../../src/events/store.js';

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-evt-'));
  dirs.push(d);
  return join(d, 'events.db');
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('event store resilience to corrupt rows', () => {
  it('skips a garbage payload row instead of throwing', () => {
    const dbPath = tmpDb();
    const store = new SqliteEventStore(dbPath);
    store.append({ runId: 'r1', type: 'RUN_CREATED', source: 'orchestrator', payload: { goal: 'g' } });
    store.append({ runId: 'r1', type: 'RUN_STARTED', source: 'orchestrator', payload: { branch: 'b' } });

    // Inject a corrupt row directly via a second connection (simulates disk
    // corruption / partial write / manual edit / future-schema row).
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA busy_timeout = 5000;');
    raw
      .prepare(
        `INSERT INTO events (event_id, ts, run_id, slice_id, attempt_id, correlation_id, source, type, schema_version, idempotency_key, payload)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?)`,
      )
      .run('evt-bad', '2026-06-21T00:00:00.000Z', 'r1', 'orchestrator', 'RUN_CREATED', 1, '{ this is not valid json');
    raw.close();

    let events;
    expect(() => {
      events = store.read('r1');
    }).not.toThrow();
    expect(events!.length).toBe(2); // the two good rows; the poison row is skipped
    expect(store.corruptRowCount()).toBe(1);

    // The other read paths are equally resilient.
    expect(() => store.recent(10, 'r1')).not.toThrow();
    expect(() => store.readSince(0, 'r1')).not.toThrow();
    store.close();
  });
});

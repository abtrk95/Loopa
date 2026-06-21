import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '../../src/events/store.js';
import { FixedClock } from '../../src/util/clock.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SqliteEventStore', () => {
  it('appends events with monotonic seq and reads them back', () => {
    const clock = new FixedClock(1000);
    const store = new SqliteEventStore(join(tmp(), 'events.db'), { clock });
    const a = store.append({ runId: 'run_1', type: 'RUN_CREATED', source: 'orchestrator', payload: { goal: 'g' } });
    const b = store.append({ runId: 'run_1', type: 'RUN_STARTED', source: 'orchestrator' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.eventId).not.toBe(b.eventId);
    const all = store.read('run_1');
    expect(all.map((e) => e.type)).toEqual(['RUN_CREATED', 'RUN_STARTED']);
    expect(all[0]!.payload['goal']).toBe('g');
    store.close();
  });

  it('honors idempotency keys (no duplicate side-effect events)', () => {
    const store = new SqliteEventStore(join(tmp(), 'events.db'));
    const first = store.append({
      runId: 'r',
      type: 'COMMIT_CREATED',
      source: 'git',
      sliceId: 'S-001',
      idempotencyKey: 'commit:S-001',
      payload: { sha: 'abc' },
    });
    const second = store.append({
      runId: 'r',
      type: 'COMMIT_CREATED',
      source: 'git',
      sliceId: 'S-001',
      idempotencyKey: 'commit:S-001',
      payload: { sha: 'abc' },
    });
    expect(second.seq).toBe(first.seq);
    expect(store.read('r')).toHaveLength(1);
    store.close();
  });

  it('survives reopen (WAL durability) and continues seq', () => {
    const dbPath = join(tmp(), 'events.db');
    const s1 = new SqliteEventStore(dbPath);
    s1.append({ runId: 'r', type: 'RUN_CREATED', source: 'orchestrator' });
    s1.close();
    const s2 = new SqliteEventStore(dbPath);
    const next = s2.append({ runId: 'r', type: 'RUN_STARTED', source: 'orchestrator' });
    expect(next.seq).toBe(2);
    expect(s2.latestSeq('r')).toBe(2);
    s2.close();
  });

  it('readSince returns only newer events', () => {
    const store = new SqliteEventStore(join(tmp(), 'events.db'));
    store.append({ runId: 'r', type: 'RUN_CREATED', source: 'orchestrator' });
    store.append({ runId: 'r', type: 'RUN_STARTED', source: 'orchestrator' });
    const since = store.readSince(1, 'r');
    expect(since).toHaveLength(1);
    expect(since[0]!.type).toBe('RUN_STARTED');
    store.close();
  });
});

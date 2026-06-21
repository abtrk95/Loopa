/**
 * Canonical event store backed by SQLite (WAL mode) via Node's built-in
 * `node:sqlite` — no native compilation required. The store is append-only;
 * sequence numbers are monotonic; writes are transactional; recovery is
 * idempotent via an optional dedupe key.
 *
 * The store is intentionally behind the `EventStore` interface (see ADR 0001) so
 * the backend can be swapped without touching callers.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { ensureDir, appendLine, chmodSafe, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../util/fs.js';
import { EventStoreError } from '../domain/errors.js';
import { newEventId } from '../domain/ids.js';
import type { Clock } from '../util/clock.js';
import { systemClock } from '../util/clock.js';
import type { Redactor } from '../security/redact.js';
import {
  AgentLoopEventSchema,
  EVENT_SCHEMA_VERSION,
  type AgentLoopEvent,
  type NewEvent,
} from './types.js';

// node:sqlite is experimental and emits a process warning on first use. Suppress
// only that specific warning so our output stays clean (see ADR 0001).
suppressSqliteExperimentalWarning();

export interface EventStore {
  append(ev: NewEvent): AgentLoopEvent;
  appendMany(evs: NewEvent[]): AgentLoopEvent[];
  /** All events for a run in seq order (or all events if runId omitted). */
  read(runId?: string): AgentLoopEvent[];
  /** Events with seq strictly greater than `afterSeq`, in seq order. */
  readSince(afterSeq: number, runId?: string): AgentLoopEvent[];
  /** The most recent `limit` events (seq order ascending within the window). */
  recent(limit: number, runId?: string): AgentLoopEvent[];
  latestSeq(runId?: string): number;
  /** Number of corrupt/undecodable rows skipped by reads so far this process. */
  corruptRowCount(): number;
  /** Distinct run ids present in the store, newest first. */
  runIds(): string[];
  exportJsonl(path: string): number;
  close(): void;
}

interface StoreOptions {
  clock?: Clock;
  /** If set, every appended event is also mirrored to this JSONL file. */
  jsonlMirrorPath?: string;
  /** If set, every event payload is redacted before it is persisted, so no
   * secret can ever land in the durable store (defense in depth). */
  redactor?: Redactor;
}

interface EventRow {
  seq: number;
  event_id: string;
  ts: string;
  run_id: string;
  slice_id: string | null;
  attempt_id: string | null;
  correlation_id: string | null;
  source: string;
  type: string;
  schema_version: number;
  payload: string;
}

const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  // v1 — initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id        TEXT NOT NULL UNIQUE,
        ts              TEXT NOT NULL,
        run_id          TEXT NOT NULL,
        slice_id        TEXT,
        attempt_id      TEXT,
        correlation_id  TEXT,
        source          TEXT NOT NULL,
        type            TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        idempotency_key TEXT,
        payload         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_run_slice ON events (run_id, slice_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
        ON events (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
  },
];

export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly jsonlMirrorPath: string | undefined;
  private readonly redactor: Redactor | undefined;
  private readonly dbPath: string;
  private sidecarsSecured = false;

  constructor(dbPath: string, opts: StoreOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.jsonlMirrorPath = opts.jsonlMirrorPath;
    this.redactor = opts.redactor;
    this.dbPath = dbPath;
    ensureDir(dirname(dbPath), { mode: PRIVATE_DIR_MODE });
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (err) {
      throw new EventStoreError(`failed to open event store at ${dbPath}`, { cause: err });
    }
    // Keep the durable log + its WAL/SHM sidecars owner-only where the OS enforces
    // POSIX modes; the parent dir is already 0700 (defense in depth). The migrate()
    // writes above create the WAL/SHM, so they exist by now; `secureSidecars()` also
    // re-applies after the first append in case a sidecar is (re)created lazily.
    this.secureSidecars();
  }

  /** Enforce owner-only modes on the db file and its WAL/SHM sidecars (idempotent). */
  private secureSidecars(): void {
    chmodSafe(this.dbPath, PRIVATE_FILE_MODE);
    chmodSafe(`${this.dbPath}-wal`, PRIVATE_FILE_MODE);
    chmodSafe(`${this.dbPath}-shm`, PRIVATE_FILE_MODE);
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);');
    const row = this.db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as
      | { version: number }
      | undefined;
    let current = row?.version ?? 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      const migration = MIGRATIONS[v];
      if (!migration) continue;
      migration(this.db);
      current = v + 1;
    }
    if (row) {
      this.db.prepare('UPDATE schema_meta SET version = ?').run(current);
    } else {
      this.db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(current);
    }
  }

  append(ev: NewEvent): AgentLoopEvent {
    return this.appendMany([ev])[0]!;
  }

  appendMany(evs: NewEvent[]): AgentLoopEvent[] {
    if (evs.length === 0) return [];
    const insert = this.db.prepare(`
      INSERT INTO events
        (event_id, ts, run_id, slice_id, attempt_id, correlation_id, source, type, schema_version, idempotency_key, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const out: AgentLoopEvent[] = [];
    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      for (const ev of evs) {
        if (ev.idempotencyKey !== undefined) {
          const existing = this.findByIdempotency(ev.runId, ev.idempotencyKey);
          if (existing) {
            out.push(existing);
            continue;
          }
        }
        const eventId = newEventId();
        const ts = this.clock.iso();
        let payload = JSON.stringify(ev.payload ?? {});
        if (this.redactor) payload = this.redactor.redact(payload);
        const payloadObj = JSON.parse(payload) as Record<string, unknown>;
        const result = insert.run(
          eventId,
          ts,
          ev.runId,
          ev.sliceId ?? null,
          ev.attemptId ?? null,
          ev.correlationId ?? null,
          ev.source,
          ev.type,
          EVENT_SCHEMA_VERSION,
          ev.idempotencyKey ?? null,
          payload,
        );
        const seq = Number(result.lastInsertRowid);
        const stored = AgentLoopEventSchema.parse({
          schemaVersion: EVENT_SCHEMA_VERSION,
          eventId,
          seq,
          ts,
          runId: ev.runId,
          sliceId: ev.sliceId ?? null,
          attemptId: ev.attemptId ?? null,
          correlationId: ev.correlationId ?? null,
          source: ev.source,
          type: ev.type,
          payload: payloadObj,
        });
        out.push(stored);
        if (this.jsonlMirrorPath) {
          appendLine(this.jsonlMirrorPath, JSON.stringify(stored), { mode: PRIVATE_FILE_MODE });
        }
      }
      commit.run();
    } catch (err) {
      rollback.run();
      throw new EventStoreError('failed to append events', { cause: err });
    }
    // The first real write is what reliably materializes the WAL/SHM sidecars;
    // re-apply owner-only modes so they are never left at the umask default.
    if (!this.sidecarsSecured) {
      this.sidecarsSecured = true;
      this.secureSidecars();
    }
    return out;
  }

  private findByIdempotency(runId: string, key: string): AgentLoopEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND idempotency_key = ? LIMIT 1')
      .get(runId, key) as EventRow | undefined;
    return row ? this.rowToEvent(row) : undefined;
  }

  private corruptRows = 0;

  read(runId?: string): AgentLoopEvent[] {
    const rows = (
      runId
        ? this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC').all(runId)
        : this.db.prepare('SELECT * FROM events ORDER BY seq ASC').all()
    ) as EventRow[];
    return this.decode(rows);
  }

  readSince(afterSeq: number, runId?: string): AgentLoopEvent[] {
    const rows = (
      runId
        ? this.db
            .prepare('SELECT * FROM events WHERE seq > ? AND run_id = ? ORDER BY seq ASC')
            .all(afterSeq, runId)
        : this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC').all(afterSeq)
    ) as EventRow[];
    return this.decode(rows);
  }

  recent(limit: number, runId?: string): AgentLoopEvent[] {
    const rows = (
      runId
        ? this.db
            .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?')
            .all(runId, limit)
        : this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit)
    ) as EventRow[];
    return this.decode(rows).reverse();
  }

  /** Number of corrupt/undecodable rows skipped by reads so far this process. */
  corruptRowCount(): number {
    return this.corruptRows;
  }

  /** Decode rows, skipping (never throwing on) any corrupt/garbage row. */
  private decode(rows: EventRow[]): AgentLoopEvent[] {
    const out: AgentLoopEvent[] = [];
    for (const r of rows) {
      const ev = this.rowToEvent(r);
      if (ev) out.push(ev);
    }
    return out;
  }

  latestSeq(runId?: string): number {
    const row = (
      runId
        ? this.db.prepare('SELECT MAX(seq) AS m FROM events WHERE run_id = ?').get(runId)
        : this.db.prepare('SELECT MAX(seq) AS m FROM events').get()
    ) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  runIds(): string[] {
    const rows = this.db
      .prepare('SELECT run_id, MAX(seq) AS m FROM events GROUP BY run_id ORDER BY m DESC')
      .all() as Array<{ run_id: string; m: number }>;
    return rows.map((r) => r.run_id);
  }

  exportJsonl(path: string): number {
    const all = this.read();
    ensureDir(dirname(path));
    const body = all.map((e) => JSON.stringify(e)).join('\n');
    appendLine(path, body);
    return all.length;
  }

  close(): void {
    this.db.close();
  }

  private rowToEvent(row: EventRow): AgentLoopEvent | undefined {
    try {
      return AgentLoopEventSchema.parse({
        schemaVersion: row.schema_version,
        eventId: row.event_id,
        seq: row.seq,
        ts: row.ts,
        runId: row.run_id,
        sliceId: row.slice_id,
        attemptId: row.attempt_id,
        correlationId: row.correlation_id,
        source: row.source,
        type: row.type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      });
    } catch {
      // A corrupt/garbage payload row (disk corruption, partial write, manual edit,
      // or a future-schema row) must NEVER poison a read of the whole log — that
      // would crash the orchestrator loop and the watcher with an unhandled
      // SyntaxError/ZodError. Skip it; recovery and reporting proceed on good rows.
      this.corruptRows++;
      return undefined;
    }
  }
}

function suppressSqliteExperimentalWarning(): void {
  const proc = process as NodeJS.Process & { __agentLoopSqliteWarnPatched?: boolean };
  if (proc.__agentLoopSqliteWarnPatched) return;
  proc.__agentLoopSqliteWarnPatched = true;
  const original = process.emit.bind(process) as (event: string, ...args: unknown[]) => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).emit = (event: string, ...args: unknown[]): boolean => {
    if (event === 'warning') {
      const warning = args[0] as { name?: string; message?: string } | undefined;
      if (warning?.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message ?? '')) {
        return false;
      }
    }
    return original(event, ...args);
  };
}

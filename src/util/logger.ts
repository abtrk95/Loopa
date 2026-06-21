/**
 * Structured + human logging with redaction. Every line is redacted before it
 * touches a file or the terminal. Loggers carry correlation context (run, slice,
 * attempt, component) that is attached to each record.
 */
import { appendLine, PRIVATE_FILE_MODE } from './fs.js';
import { Redactor } from '../security/redact.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  runId?: string;
  sliceId?: string;
  attemptId?: string;
  correlationId?: string;
  component?: string;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Absolute path to the structured JSONL log file (optional). */
  filePath?: string;
  /** Mirror human-readable lines to this stream (e.g. process.stderr). */
  stream?: NodeJS.WritableStream | undefined;
  redactor?: Redactor;
  clock?: Clock;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly filePath: string | undefined;
  private readonly stream: NodeJS.WritableStream | undefined;
  private readonly redactor: Redactor;
  private readonly clock: Clock;
  private readonly context: LogContext;

  constructor(opts: LoggerOptions = {}, context: LogContext = {}) {
    this.level = opts.level ?? 'info';
    this.filePath = opts.filePath;
    this.stream = opts.stream;
    this.redactor = opts.redactor ?? new Redactor();
    this.clock = opts.clock ?? systemClock;
    this.context = context;
  }

  child(context: LogContext): Logger {
    return new Logger(
      {
        level: this.level,
        ...(this.filePath ? { filePath: this.filePath } : {}),
        stream: this.stream,
        redactor: this.redactor,
        clock: this.clock,
      },
      { ...this.context, ...context },
    );
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }

  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const ts = this.clock.iso();
    const redactedMsg = this.redactor.redact(msg);
    const record = {
      ts,
      level,
      msg: redactedMsg,
      ...this.context,
      ...(fields ? { fields: this.redactFields(fields) } : {}),
    };
    const line = this.redactor.redact(JSON.stringify(record));
    if (this.filePath) {
      try {
        appendLine(this.filePath, line, { mode: PRIVATE_FILE_MODE });
      } catch {
        // Logging must never crash the engine. A failed log write is non-fatal.
      }
    }
    if (this.stream) {
      const ctx = this.context.component ? ` [${this.context.component}]` : '';
      this.stream.write(`${ts} ${level.toUpperCase().padEnd(5)}${ctx} ${redactedMsg}\n`);
    }
  }

  private redactFields(fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = typeof v === 'string' ? this.redactor.redact(v) : v;
    }
    return out;
  }
}

/** A logger that discards everything (useful as a default in pure components). */
export const nullLogger = new Logger({ level: 'error' });

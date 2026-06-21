import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch } from '../../src/watch/dashboard.js';
import { Logger } from '../../src/util/logger.js';
import { Redactor } from '../../src/security/redact.js';
import { runScenario, cleanupRepos } from '../helpers.js';

afterEach(cleanupRepos);

class MemoryWritable extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

const DONE_PRD = { description: 'x', userStories: [{ id: 'A', title: 'alpha', description: 'd', acceptanceCriteria: ['a'], allowedPaths: ['src/a.js'] }] };
const DONE_FAKE = { slices: { 'S-001': { files: { 'src/a.js': '1\n' } } }, reviews: {} };

describe('watcher attach + reconnect', () => {
  it('renders a JSON snapshot once, and re-attaching is consistent', async () => {
    const r = await runScenario({ prd: DONE_PRD, fake: DONE_FAKE });
    const out1 = new MemoryWritable();
    const code1 = await runWatch({ root: r.root, once: true, json: true, out: out1 });
    expect(code1).toBe(0);
    const snap1 = JSON.parse(out1.text());
    expect(snap1.snapshot.runState).toBe('COMPLETED');
    expect(snap1.snapshot.verifiedCompleted).toBe(1);

    // Reconnect from a fresh watcher (new store connection): same view.
    const out2 = new MemoryWritable();
    await runWatch({ root: r.root, once: true, json: true, out: out2 });
    expect(JSON.parse(out2.text()).snapshot.runState).toBe('COMPLETED');
  });

  it('renders a plain text frame for non-TTY output', async () => {
    const r = await runScenario({ prd: DONE_PRD, fake: DONE_FAKE });
    const out = new MemoryWritable();
    await runWatch({ root: r.root, once: true, out });
    expect(out.text()).toContain('agent-loop watch — COMPLETED');
    expect(out.text()).toContain('progress: 1/1');
  });
});

describe('secret redaction in stored data', () => {
  it('logger redacts literal and pattern secrets in the log file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-log-'));
    try {
      const logPath = join(dir, 'log.jsonl');
      const logger = new Logger({ level: 'info', filePath: logPath, redactor: new Redactor(['literalSecret123']) });
      logger.info('using ghp_' + 'a'.repeat(30) + ' and literalSecret123');
      const content = readFileSync(logPath, 'utf8');
      expect(content).toContain('***REDACTED***');
      expect(content).not.toContain('literalSecret123');
      expect(content).not.toMatch(/ghp_a{30}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts secrets in stored agent-output events', async () => {
    const secret = 'ghp_' + 'b'.repeat(30);
    const r = await runScenario({
      prd: DONE_PRD,
      // The fake provider summary carries a secret-shaped token.
      fake: { slices: { 'S-001': { files: { 'src/a.js': '1\n' }, summary: `wrote with token ${secret}` } }, reviews: {} },
    });
    const jsonl = readFileSync(join(r.root, '.agent-loop/events/events.jsonl'), 'utf8');
    expect(jsonl).not.toContain(secret);
    expect(jsonl).toContain('***REDACTED***');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, deepMerge, envOverrides } from '../../src/config/load.js';
import { ConfigSchema } from '../../src/config/config.js';
import { Router } from '../../src/providers/routing.js';
import { project, progressPercent } from '../../src/events/projection.js';
import type { AgentLoopEvent } from '../../src/events/types.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-cfg-'));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('config precedence', () => {
  it('merges defaults < project < cli', () => {
    const root = tmp();
    mkdirSync(join(root, '.agent-loop'), { recursive: true });
    writeFileSync(join(root, '.agent-loop', 'config.yml'), 'execution:\n  concurrency: 3\nauto: true\n');
    const { config } = loadConfig({ root, skipUserConfig: true, cliOverrides: { execution: { concurrency: 5 } } });
    expect(config.execution.concurrency).toBe(5); // cli wins
    expect(config.auto).toBe(true); // from project file
    expect(config.execution.maxRetriesPerSlice).toBe(2); // default
  });
  it('deepMerge replaces arrays but merges objects', () => {
    expect(deepMerge({ a: { x: 1 }, list: [1, 2] }, { a: { y: 2 }, list: [3] })).toEqual({ a: { x: 1, y: 2 }, list: [3] });
  });
  it('maps env vars to overrides', () => {
    const o = envOverrides({ AGENT_LOOP_AUTO: '1', AGENT_LOOP_WORKER: 'codex:gpt', AGENT_LOOP_CONCURRENCY: '4' });
    expect(o).toMatchObject({ auto: true, roles: { workers: [{ provider: 'codex', model: 'gpt' }] }, execution: { concurrency: 4 } });
  });
  it('rejects invalid config with an actionable error', () => {
    const root = tmp();
    mkdirSync(join(root, '.agent-loop'), { recursive: true });
    writeFileSync(join(root, '.agent-loop', 'config.yml'), 'execution:\n  concurrency: -1\n');
    expect(() => loadConfig({ root, skipUserConfig: true })).toThrow(/invalid configuration/);
  });
});

describe('router strategies', () => {
  it('round-robins workers', () => {
    const config = ConfigSchema.parse({ roles: { workers: [{ provider: 'a' }, { provider: 'b' }] }, routing: { workerStrategy: 'round-robin' } });
    const r = new Router(config);
    expect([r.worker(1).provider, r.worker(1).provider, r.worker(1).provider]).toEqual(['a', 'b', 'a']);
  });
  it('weights workers', () => {
    const config = ConfigSchema.parse({ roles: { workers: [{ provider: 'a', weight: 2 }, { provider: 'b', weight: 1 }] }, routing: { workerStrategy: 'weighted' } });
    const r = new Router(config);
    const picks = [r.worker(1), r.worker(1), r.worker(1)].map((s) => s.provider);
    expect(picks.filter((p) => p === 'a').length).toBe(2);
  });
  it('static always picks the first', () => {
    const config = ConfigSchema.parse({ roles: { workers: [{ provider: 'a' }, { provider: 'b' }] }, routing: { workerStrategy: 'static' } });
    const r = new Router(config);
    expect(r.worker(1).provider).toBe('a');
    expect(r.worker(2).provider).toBe('a');
  });
  it('routes planner/reviewer/fixer/fallbacks', () => {
    const config = ConfigSchema.parse({
      roles: { planner: { provider: 'p' }, workers: [{ provider: 'w' }], reviewer: { provider: 'rev' }, fixer: { provider: 'fix' } },
      routing: { fallbackOrder: ['x', 'w', 'y'] },
    });
    const r = new Router(config);
    expect(r.planner().provider).toBe('p');
    expect(r.reviewer()?.provider).toBe('rev');
    expect(r.fixer(r.worker(1)).provider).toBe('fix');
    expect(r.fallbacks('w').map((s) => s.provider)).toEqual(['x', 'y']);
  });
  it('fixer same-as-worker returns the worker selection', () => {
    const config = ConfigSchema.parse({ roles: { workers: [{ provider: 'w' }], fixer: { strategy: 'same-as-worker' } } });
    const r = new Router(config);
    const w = r.worker(1);
    expect(r.fixer(w).provider).toBe('w');
  });
});

describe('projection / progress', () => {
  function ev(seq: number, type: string, payload: Record<string, unknown> = {}, sliceId: string | null = null): AgentLoopEvent {
    return { schemaVersion: 1, eventId: `e${seq}`, seq, ts: '2026-01-01T00:00:00Z', runId: 'r', sliceId, attemptId: null, correlationId: null, source: 'orchestrator', type: type as AgentLoopEvent['type'], payload };
  }
  it('computes verified progress from completed slices only', () => {
    const events: AgentLoopEvent[] = [
      ev(1, 'PLAN_CREATED', { totalSlices: 2, sliceIds: ['S-001', 'S-002'], goal: 'g', branch: 'b' }),
      ev(2, 'RUN_STARTED', { branch: 'b' }),
      ev(3, 'SLICE_STATE_CHANGED', { from: 'PENDING', to: 'EXECUTING' }, 'S-001'),
      ev(4, 'SLICE_COMPLETED', { sha: 'abc' }, 'S-001'),
      ev(5, 'SLICE_STATE_CHANGED', { from: 'PENDING', to: 'COMPLETED' }, 'S-001'),
    ];
    const snap = project(events);
    expect(snap.totalSlices).toBe(2);
    expect(snap.verifiedCompleted).toBe(1);
    expect(progressPercent(snap)).toBe(50);
  });
  it('agent output never affects progress', () => {
    const events: AgentLoopEvent[] = [
      ev(1, 'PLAN_CREATED', { totalSlices: 1, sliceIds: ['S-001'] }),
      ev(2, 'AGENT_PROCESS_OUTPUT', { line: 'I am 100% done!' }, 'S-001'),
      ev(3, 'AGENT_PROCESS_EXITED', { exitCode: 0 }, 'S-001'),
    ];
    expect(project(events).verifiedCompleted).toBe(0); // no COMPLETED state
  });
});

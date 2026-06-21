import { describe, it, expect } from 'vitest';
import { detectCycle, topoOrder, eligibleSlices, canRunInParallel, pathScopesOverlap, findGraphIssues } from '../../src/planner/graph.js';
import { validatePlan } from '../../src/planner/validate.js';
import { buildPlan } from '../../src/planner/plan.js';
import { ObjectiveSchema, type Slice } from '../../src/domain/schemas.js';

function slice(id: string, deps: string[] = [], allowed = ['src/**'], parallelSafe = false): Slice {
  return {
    id, title: `t-${id}`, description: 'd', acceptanceCriteria: ['c'], dependencies: deps,
    allowedPaths: allowed, forbiddenPaths: [], requiredChecks: [], risk: 'low', preferredRole: 'worker', parallelSafe,
  };
}

describe('dependency graph', () => {
  it('detects cycles', () => {
    expect(detectCycle([slice('S-001', ['S-002']), slice('S-002', ['S-001'])])).not.toBeNull();
    expect(detectCycle([slice('S-001'), slice('S-002', ['S-001'])])).toBeNull();
  });
  it('topo-orders dependencies first, stable by input order', () => {
    const order = topoOrder([slice('S-003', ['S-001', 'S-002']), slice('S-001'), slice('S-002', ['S-001'])]);
    expect(order.map((s) => s.id)).toEqual(['S-001', 'S-002', 'S-003']);
  });
  it('computes eligible slices from completed set', () => {
    const slices = [slice('S-001'), slice('S-002', ['S-001'])];
    expect(eligibleSlices(slices, new Set(), new Set()).map((s) => s.id)).toEqual(['S-001']);
    expect(eligibleSlices(slices, new Set(['S-001']), new Set()).map((s) => s.id)).toEqual(['S-002']);
  });
  it('flags missing dependency references', () => {
    const issues = findGraphIssues([slice('S-001', ['S-999'])]);
    expect(issues.some((i) => i.kind === 'missing-dependency')).toBe(true);
  });
  it('parallel-safety requires disjoint scopes and parallelSafe', () => {
    const a = slice('S-001', [], ['src/a/**'], true);
    const b = slice('S-002', [], ['src/b/**'], true);
    const c = slice('S-003', [], ['src/a/**'], true);
    expect(canRunInParallel(a, b)).toBe(true);
    expect(canRunInParallel(a, c)).toBe(false); // overlapping scope
    expect(pathScopesOverlap(a, b)).toBe(false);
    expect(canRunInParallel(a, slice('S-004', [], ['src/b/**'], false))).toBe(false); // not parallelSafe
  });
  it('treats ** as overlapping everything', () => {
    expect(pathScopesOverlap(slice('S-001', [], ['**']), slice('S-002', [], ['src/x/**']))).toBe(true);
  });
});

describe('plan validation', () => {
  const objective = ObjectiveSchema.parse({ goal: 'g', repository: { root: '/tmp' }, source: { kind: 'idea' } });

  it('accepts a valid plan and rejects cycles', () => {
    const ok = buildPlan(objective, [
      { title: 'a', description: 'd', acceptanceCriteria: ['x'], allowedPaths: ['src/a'], id: 'A' },
      { title: 'b', description: 'd', acceptanceCriteria: ['y'], allowedPaths: ['src/b'], id: 'B' },
    ], { createdAt: '2026-01-01T00:00:00Z', branch: 'b' });
    expect(validatePlan(ok).ok).toBe(true);

    const cyclic = { ...ok, slices: [{ ...ok.slices[0]!, dependencies: ['S-002'] }, { ...ok.slices[1]!, dependencies: ['S-001'] }] };
    expect(validatePlan(cyclic).ok).toBe(false);
  });

  it('rejects an impossible path policy (allowed all forbidden)', () => {
    const plan = buildPlan(objective, [{ title: 'a', description: 'd', acceptanceCriteria: ['x'], allowedPaths: ['.env'], forbiddenPaths: ['.env'] }], { createdAt: 't', branch: 'b' });
    expect(validatePlan(plan).ok).toBe(false);
  });
});

describe('buildPlan', () => {
  const objective = ObjectiveSchema.parse({ goal: 'Add billing', repository: { root: '/tmp' }, source: { kind: 'idea' } });
  it('maps stories to ordered slices with dependency id remapping', () => {
    const plan = buildPlan(objective, [
      { id: 'US2', title: 'second', description: 'd', acceptanceCriteria: ['b'], priority: 2, dependencies: ['US1'] },
      { id: 'US1', title: 'first', description: 'd', acceptanceCriteria: ['a'], priority: 1 },
    ], { createdAt: 't', branch: 'b' });
    expect(plan.slices.map((s) => s.title)).toEqual(['first', 'second']);
    // US1 became S-001, so the second slice depends on S-001
    expect(plan.slices[1]!.dependencies).toEqual(['S-001']);
  });
  it('produces a single conservative slice for an idea', () => {
    const plan = buildPlan(objective, [], { createdAt: 't', branch: 'b' });
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]!.allowedPaths).toEqual(['**']);
  });
});

/**
 * Dependency-graph utilities over a plan's slices: cycle detection, deterministic
 * topological ordering, eligibility (which slices are ready given what's done),
 * and conservative path-scope overlap analysis used to decide whether two slices
 * may run in parallel.
 */
import type { Slice } from '../domain/schemas.js';

export interface GraphIssue {
  kind: 'missing-dependency' | 'cycle' | 'duplicate-id';
  detail: string;
}

export function findGraphIssues(slices: readonly Slice[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();
  for (const s of slices) {
    if (ids.has(s.id)) issues.push({ kind: 'duplicate-id', detail: s.id });
    ids.add(s.id);
  }
  for (const s of slices) {
    for (const dep of s.dependencies) {
      if (!ids.has(dep)) {
        issues.push({ kind: 'missing-dependency', detail: `${s.id} -> ${dep}` });
      }
    }
  }
  const cycle = detectCycle(slices);
  if (cycle) issues.push({ kind: 'cycle', detail: cycle.join(' -> ') });
  return issues;
}

/** Returns a cycle path if one exists, else null. */
export function detectCycle(slices: readonly Slice[]): string[] | null {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const st = state.get(id);
    if (st === 'done') return null;
    if (st === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    const slice = byId.get(id);
    for (const dep of slice?.dependencies ?? []) {
      if (!byId.has(dep)) continue;
      const cyc = visit(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const s of slices) {
    const cyc = visit(s.id);
    if (cyc) return cyc;
  }
  return null;
}

/** Deterministic topological order: dependencies first, ties broken by input order. */
export function topoOrder(slices: readonly Slice[]): Slice[] {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const indegree = new Map<string, number>();
  const position = new Map<string, number>();
  slices.forEach((s, i) => {
    position.set(s.id, i);
    indegree.set(s.id, 0);
  });
  for (const s of slices) {
    for (const dep of s.dependencies) {
      if (byId.has(dep)) indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1);
    }
  }
  const dependents = new Map<string, string[]>();
  for (const s of slices) {
    for (const dep of s.dependencies) {
      if (!byId.has(dep)) continue;
      const list = dependents.get(dep) ?? [];
      list.push(s.id);
      dependents.set(dep, list);
    }
  }
  const ready = slices.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  ready.sort((a, b) => (position.get(a)! - position.get(b)!));
  const out: Slice[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const dep of (dependents.get(id) ?? []).sort((a, b) => position.get(a)! - position.get(b)!)) {
      indegree.set(dep, (indegree.get(dep) ?? 0) - 1);
      if ((indegree.get(dep) ?? 0) === 0) {
        // insert maintaining position order
        const pos = position.get(dep)!;
        let i = 0;
        while (i < ready.length && position.get(ready[i]!)! < pos) i++;
        ready.splice(i, 0, dep);
      }
    }
  }
  return out;
}

/** Slices ready to run: all dependencies completed, not done/in-progress. */
export function eligibleSlices(
  slices: readonly Slice[],
  completed: ReadonlySet<string>,
  busy: ReadonlySet<string>,
): Slice[] {
  return slices.filter(
    (s) =>
      !completed.has(s.id) &&
      !busy.has(s.id) &&
      s.dependencies.every((d) => completed.has(d)),
  );
}

/** The literal prefix of a glob before its first wildcard. */
export function scopePrefix(glob: string): string {
  const wildcard = glob.search(/[*?[]/);
  const prefix = wildcard < 0 ? glob : glob.slice(0, wildcard);
  const lastSlash = prefix.lastIndexOf('/');
  return lastSlash < 0 ? '' : prefix.slice(0, lastSlash + 1);
}

/** Conservative overlap: any of a's scope prefixes is a prefix of b's (or vice
 * versa), or either declares the repo-wide '**'. Returns true when uncertain. */
export function pathScopesOverlap(a: Slice, b: Slice): boolean {
  const aGlobs = a.allowedPaths;
  const bGlobs = b.allowedPaths;
  if (aGlobs.includes('**') || bGlobs.includes('**') || aGlobs.includes('**/*') || bGlobs.includes('**/*')) {
    return true;
  }
  const aPrefixes = aGlobs.map(scopePrefix);
  const bPrefixes = bGlobs.map(scopePrefix);
  for (const ap of aPrefixes) {
    for (const bp of bPrefixes) {
      if (ap === bp || ap.startsWith(bp) || bp.startsWith(ap)) return true;
    }
  }
  return false;
}

/** Two slices may run concurrently only if both are parallelSafe and their file
 * scopes do not overlap. */
export function canRunInParallel(a: Slice, b: Slice): boolean {
  return a.parallelSafe && b.parallelSafe && !pathScopesOverlap(a, b);
}

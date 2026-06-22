/**
 * Diagnostic commands: doctor (environment readiness), providers (adapter health),
 * inspect (explain why a run/slice is in its current state).
 */
import { SqliteEventStore } from '../../events/store.js';
import { ProcessManager } from '../../process/manager.js';
import { projectPaths } from '../../util/paths.js';
import { loadConfig } from '../../config/load.js';
import { createRegistry } from '../../providers/registry.js';
import { loadRunMeta } from '../../orchestrator/session.js';
import { project } from '../../events/projection.js';
import { errorMessage } from '../../domain/errors.js';
import { flagBool, resolveRoot, type ParsedArgs } from '../args.js';

export async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const out = process.stdout;
  let ok = true;
  const line = (label: string, pass: boolean, detail: string): void => {
    if (!pass) ok = false;
    out.write(`  ${pass ? '✓' : '✗'} ${label.padEnd(22)} ${detail}\n`);
  };
  // A non-failing advisory line (e.g. an optional provider that isn't installed):
  // shown with a distinct marker so a green ✓ never misrepresents an absent tool.
  const warnLine = (label: string, detail: string): void => {
    out.write(`  ! ${label.padEnd(22)} ${detail}\n`);
  };

  out.write('agent-loop doctor\n\n');

  const [major, minor] = process.versions.node.split('.').map(Number);
  line('node >= 22.5', (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5), `found ${process.versions.node}`);

  try {
    const m = await import('node:sqlite');
    line('node:sqlite', Boolean(m.DatabaseSync), 'built-in SQLite available');
  } catch {
    line('node:sqlite', false, 'not available — upgrade Node');
  }

  const pm = new ProcessManager();
  const git = await pm.run(['git', '--version'], { cwd: root, timeoutMs: 10_000 }).catch(() => undefined);
  line('git', Boolean(git?.ok), git?.ok ? git.stdout.trim() : 'git not found');

  let configOk = true;
  let config;
  try {
    config = loadConfig({ root }).config;
    line('config', true, 'valid');
  } catch (err) {
    configOk = false;
    line('config', false, errorMessage(err));
  }

  if (configOk && config) {
    const registry = createRegistry(config, root, pm);
    for (const adapter of registry.all()) {
      const health = await adapter.health();
      const detail = health.detail ?? (health.ok ? 'ok' : 'not installed');
      // The fake provider is always healthy; a real provider may be absent — that's a
      // non-failing advisory (you may only use some of them), shown with `!` rather
      // than a misleading green ✓.
      if (adapter.id === 'fake') line(`provider:${adapter.id}`, health.ok, detail);
      else if (health.ok) line(`provider:${adapter.id}`, true, detail);
      else warnLine(`provider:${adapter.id}`, detail);
    }
  }

  out.write(`\n${ok ? 'All critical checks passed.' : 'Some critical checks failed.'}\n`);
  void flagBool(args, 'json');
  return ok ? 0 : 1;
}

export async function cmdProviders(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const config = loadConfig({ root }).config;
  const pm = new ProcessManager();
  const registry = createRegistry(config, root, pm);
  const rows: Array<{ id: string; version: string; health: string; roles: string }> = [];
  for (const adapter of registry.all()) {
    const version = (await adapter.detectVersion()) ?? 'not installed';
    const health = await adapter.health();
    rows.push({ id: adapter.id, version, health: health.ok ? 'ok' : 'unavailable', roles: adapter.capabilities().roles.join(',') });
  }
  if (flagBool(args, 'json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  process.stdout.write('Providers:\n');
  for (const r of rows) {
    process.stdout.write(`  ${r.id.padEnd(10)} ${r.health.padEnd(12)} ${r.version.padEnd(28)} roles=${r.roles}\n`);
  }
  return 0;
}

export function cmdInspect(args: ParsedArgs): number {
  const root = resolveRoot(args);
  const paths = projectPaths(root);
  const runId = args.positionals[0] ?? loadRunMeta(paths)?.runId;
  if (!runId) {
    process.stdout.write('No run to inspect.\n');
    return 1;
  }
  const store = new SqliteEventStore(paths.eventsDb);
  try {
    const events = store.read(runId);
    const snap = project(events);
    const out = process.stdout;
    out.write(`Run ${runId} — state ${snap.runState}\n`);
    out.write(`Goal: ${snap.goal}\n\n`);
    for (const id of snap.sliceOrder) {
      const s = snap.slices[id];
      if (!s) continue;
      out.write(`${id} ${s.title}\n  state: ${s.state}  attempts: ${s.attempts}  retries: ${s.retries}\n`);
      const sliceEvents = events.filter((e) => e.sliceId === id).slice(-6);
      for (const e of sliceEvents) {
        const why = e.type === 'VERIFICATION_FAILED' || e.type === 'SLICE_BLOCKED' ? ` — ${e.payload['reason'] ?? ''}` : '';
        out.write(`    ${e.ts.slice(11, 19)} ${e.type}${why}\n`);
      }
    }
    if (snap.blocker) out.write(`\nBlocker: ${snap.blocker.reason}\n`);
    out.write(`\nProgress is verified-completed/total = ${snap.verifiedCompleted}/${snap.totalSlices}.\n`);
    return 0;
  } finally {
    store.close();
  }
}

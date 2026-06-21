/**
 * Control + inspection commands that don't run the engine: status, pause, resume,
 * stop, logs, diff. These talk to the durable store and the control plane only.
 */
import { existsSync, readFileSync, watchFile } from 'node:fs';
import { SqliteEventStore } from '../../events/store.js';
import { GitRepo } from '../../git/repo.js';
import { ProcessManager } from '../../process/manager.js';
import { projectPaths } from '../../util/paths.js';
import { loadRunMeta } from '../../orchestrator/session.js';
import { ControlPlane } from '../../orchestrator/control.js';
import { project, progressPercent } from '../../events/projection.js';
import { ControlError } from '../../domain/errors.js';
import { flagBool, flagNum, resolveRoot, type ParsedArgs } from '../args.js';

function requireRunId(root: string): { runId: string; paths: ReturnType<typeof projectPaths> } {
  const paths = projectPaths(root);
  const meta = loadRunMeta(paths);
  if (!meta) throw new ControlError('no run found for this project. Run `agent-loop plan` then `agent-loop run`.');
  return { runId: meta.runId, paths };
}

export async function cmdStatus(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const { runId, paths } = requireRunId(root);
  if (!existsSync(paths.eventsDb)) {
    process.stdout.write('No events yet.\n');
    return 0;
  }
  const store = new SqliteEventStore(paths.eventsDb);
  try {
    const snap = project(store.read(runId));
    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
      return 0;
    }
    const out = process.stdout;
    out.write(`Run:      ${snap.runId}\n`);
    out.write(`State:    ${snap.runState}\n`);
    out.write(`Goal:     ${snap.goal}\n`);
    out.write(`Branch:   ${snap.branch}\n`);
    out.write(`Progress: ${snap.verifiedCompleted}/${snap.totalSlices} (${progressPercent(snap)}%)\n`);
    if (snap.currentSliceId) out.write(`Current:  ${snap.currentSliceId} (${snap.currentPhase ?? '—'})\n`);
    if (snap.blocker) out.write(`Blocker:  ${snap.blocker.reason}\n`);
    out.write('\nSlices:\n');
    for (const id of snap.sliceOrder) {
      const s = snap.slices[id];
      if (s) out.write(`  ${id} ${s.state.padEnd(12)} ${s.title}\n`);
    }
    return snap.runState === 'COMPLETED' ? 0 : snap.runState === 'BLOCKED' ? 2 : snap.runState === 'FAILED' ? 1 : 0;
  } finally {
    store.close();
  }
}

export function cmdPause(args: ParsedArgs): number {
  const root = resolveRoot(args);
  const { paths } = requireRunId(root);
  new ControlPlane(paths.controlDir).requestPause(Date.now());
  process.stdout.write('Pause requested. The running engine will pause at the next checkpoint.\n');
  return 0;
}

export function cmdResume(args: ParsedArgs): number {
  const root = resolveRoot(args);
  const { paths } = requireRunId(root);
  new ControlPlane(paths.controlDir).requestResume(Date.now());
  process.stdout.write('Resume requested.\n');
  return 0;
}

export function cmdStop(args: ParsedArgs): number {
  const root = resolveRoot(args);
  const { paths } = requireRunId(root);
  new ControlPlane(paths.controlDir).requestStop(Date.now());
  process.stdout.write('Stop requested. In-flight processes will be terminated.\n');
  return 0;
}

export async function cmdLogs(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const paths = projectPaths(root);
  const logPath = paths.logsDir + '/agent-loop.log';
  if (!existsSync(logPath)) {
    process.stdout.write('No logs yet.\n');
    return 0;
  }
  const n = flagNum(args, 'lines') ?? 200;
  const printTail = (): void => {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    process.stdout.write(lines.slice(-n).join('\n') + '\n');
  };
  printTail();
  if (flagBool(args, 'follow')) {
    let size = readFileSync(logPath, 'utf8').length;
    return await new Promise<number>(() => {
      watchFile(logPath, { interval: 500 }, () => {
        const content = readFileSync(logPath, 'utf8');
        if (content.length > size) {
          process.stdout.write(content.slice(size));
          size = content.length;
        }
      });
    });
  }
  return 0;
}

export async function cmdDiff(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const git = new GitRepo(root, new ProcessManager());
  if (!(await git.isRepo())) {
    process.stdout.write('Not a git repository.\n');
    return 1;
  }
  const diff = await git.diff();
  process.stdout.write(diff || '(no uncommitted changes)\n');
  return 0;
}

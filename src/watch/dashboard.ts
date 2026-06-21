/**
 * Live terminal watcher. Read-only with respect to authoritative state: it derives
 * everything from the event store + live git, and the only thing it writes is a
 * control-plane request (pause/resume/stop) when the user presses a key — never run
 * state directly. It can attach to a running run from another terminal, detach, and
 * reconnect, because all state lives in the durable store.
 */
import { existsSync, readFileSync } from 'node:fs';
import { SqliteEventStore } from '../events/store.js';
import { ProcessManager } from '../process/manager.js';
import { GitRepo } from '../git/repo.js';
import { Redactor } from '../security/redact.js';
import { collectSecretValues } from '../security/env.js';
import { projectPaths } from '../util/paths.js';
import { loadRunMeta } from '../orchestrator/session.js';
import { ControlPlane } from '../orchestrator/control.js';
import { project } from '../events/projection.js';
import { renderDashboard, renderPlain, type WatchModel, type RenderOptions } from './render.js';

export interface WatchOptions {
  root: string;
  runId?: string | undefined;
  json?: boolean;
  plain?: boolean;
  color?: boolean;
  once?: boolean;
  intervalMs?: number;
  compact?: boolean;
  noGit?: boolean;
  /** Exit the live loop automatically once the run reaches a terminal state. */
  exitWhenFinished?: boolean;
  /** Streams for testability (default process.stdout/stdin). */
  out?: NodeJS.WritableStream;
}

interface WatchCtx {
  store: SqliteEventStore;
  git: GitRepo;
  runId: string;
  control: ControlPlane;
  logPath: string;
}

async function buildModel(ctx: WatchCtx, noGit: boolean, nowMs: number): Promise<WatchModel> {
  const events = ctx.store.read(ctx.runId);
  const snapshot = project(events);
  const recentEvents = ctx.store.recent(14, ctx.runId);
  const git = { branch: snapshot.branch, clean: true, uncommitted: 0, lastCommit: undefined as { sha: string; message: string } | undefined };
  if (!noGit) {
    try {
      const status = (await ctx.git.status()).filter((sfile) => !sfile.path.startsWith('.agent-loop'));
      git.clean = status.length === 0;
      git.uncommitted = status.length;
      git.branch = await ctx.git.currentBranch();
      git.lastCommit = await ctx.git.lastCommit();
    } catch {
      // not a repo / detached — leave defaults
    }
  }
  return { snapshot, git, recentEvents, nowMs };
}

export async function runWatch(opts: WatchOptions): Promise<number> {
  const out = opts.out ?? process.stdout;
  const paths = projectPaths(opts.root);
  const runId = opts.runId ?? loadRunMeta(paths)?.runId;
  if (!runId) {
    out.write('No run found. Run `agent-loop plan` then `agent-loop run` first.\n');
    return 1;
  }
  if (!existsSync(paths.eventsDb)) {
    out.write('No event store found for this project yet.\n');
    return 1;
  }
  // The watcher reads live git (last commit message, the `g` diff view). Route it
  // through a redactor so no secret reaches the dashboard even from untracked diffs.
  const redactor = new Redactor(collectSecretValues(process.env));
  const ctx: WatchCtx = {
    store: new SqliteEventStore(paths.eventsDb),
    git: new GitRepo(opts.root, new ProcessManager(), redactor),
    runId,
    control: new ControlPlane(paths.controlDir),
    logPath: paths.logsDir + '/agent-loop.log',
  };

  const isTty = Boolean((out as NodeJS.WriteStream).isTTY);
  const color = (opts.color ?? true) && isTty && !opts.plain && !opts.json;

  try {
    if (opts.json) {
      const model = await buildModel(ctx, opts.noGit ?? false, Date.now());
      if (opts.once || !isTty) {
        out.write(JSON.stringify({ snapshot: model.snapshot, git: model.git }) + '\n');
        return 0;
      }
      return await liveJson(ctx, opts, out);
    }
    if (opts.once || !isTty) {
      const model = await buildModel(ctx, opts.noGit ?? false, Date.now());
      const opt: RenderOptions = { width: termWidth(out), color, ...(opts.compact !== undefined ? { compact: opts.compact } : {}) };
      out.write((opts.plain || !isTty ? renderPlain(model) : renderDashboard(model, opt)) + '\n');
      return 0;
    }
    return await liveLoop(ctx, opts, out, color);
  } finally {
    ctx.store.close();
  }
}

function termWidth(out: NodeJS.WritableStream): number {
  return (out as NodeJS.WriteStream).columns ?? 100;
}

async function liveJson(ctx: WatchCtx, opts: WatchOptions, out: NodeJS.WritableStream): Promise<number> {
  const interval = opts.intervalMs ?? 1000;
  return new Promise<number>((resolve) => {
    const timer = setInterval(async () => {
      const model = await buildModel(ctx, opts.noGit ?? false, Date.now());
      out.write(JSON.stringify({ snapshot: model.snapshot, git: model.git }) + '\n');
      if (model.snapshot.finished) {
        clearInterval(timer);
        resolve(0);
      }
    }, interval);
    setupQuit(() => {
      clearInterval(timer);
      resolve(0);
    });
  });
}

async function liveLoop(ctx: WatchCtx, opts: WatchOptions, out: NodeJS.WritableStream, color: boolean): Promise<number> {
  const interval = opts.intervalMs ?? 1000;
  let view: 'dashboard' | 'logs' | 'diff' = 'dashboard';
  let stopped = false;
  let lastFinished = false;

  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
  }

  const render = async (): Promise<void> => {
    const model = await buildModel(ctx, opts.noGit ?? false, Date.now());
    lastFinished = model.snapshot.finished;
    let frame: string;
    if (view === 'logs') frame = modalFrame('LOGS (press any key to return)', tail(ctx.logPath, 40));
    else if (view === 'diff') frame = modalFrame('GIT DIFF (press any key to return)', await diff(ctx.git));
    else {
      const opt: RenderOptions = { width: termWidth(out), color, ...(opts.compact !== undefined ? { compact: opts.compact } : {}) };
      frame = renderDashboard(model, opt);
    }
    out.write('\x1b[H\x1b[2J' + frame + '\n');
  };

  return await new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw);
        stdin.pause();
      }
      stdin.removeListener('data', onKey);
      process.removeListener('SIGINT', onSigint);
      out.write('\x1b[?25h'); // show cursor
      resolve(code);
    };
    const onSigint = (): void => finish(0);
    const onKey = (key: string): void => {
      for (const ch of key) {
        if (ch === 'q' || ch === '\x03') return finish(0);
        if (view !== 'dashboard') {
          view = 'dashboard';
          continue;
        }
        if (ch === 'p') ctx.control.requestPause(Date.now());
        else if (ch === 'r') ctx.control.requestResume(Date.now());
        else if (ch === 'l') view = 'logs';
        else if (ch === 'g') view = 'diff';
      }
      void render();
    };
    if (stdin.isTTY) stdin.on('data', onKey);
    process.on('SIGINT', onSigint);
    out.write('\x1b[?25l'); // hide cursor
    const timer = setInterval(() => {
      void render().then(() => {
        if (opts.exitWhenFinished && lastFinished) finish(0);
      });
    }, interval);
    void render();
  });
}

function setupQuit(onQuit: () => void): void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\x03') {
      stdin.setRawMode(false);
      stdin.pause();
      onQuit();
    }
  });
}

function modalFrame(title: string, body: string): string {
  return `── ${title} ──\n\n${body}\n`;
}

function tail(path: string, n: number): string {
  if (!existsSync(path)) return '(no logs yet)';
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.slice(-n).join('\n');
}

async function diff(git: GitRepo): Promise<string> {
  try {
    const d = await git.diff();
    return d ? d.slice(0, 8000) : '(no uncommitted diff)';
  } catch {
    return '(diff unavailable)';
  }
}

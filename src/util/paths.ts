/**
 * Canonical on-disk layout for a project's `.agent-loop/` directory. Every path
 * is derived from the repository root so the layout is identical across runs and
 * platforms.
 */
import { join } from 'node:path';
import { atomicWrite, ensureDir, fileExists, PRIVATE_DIR_MODE } from './fs.js';

export const AGENT_DIR = '.agent-loop';

export interface ProjectPaths {
  readonly root: string;
  readonly dir: string;
  readonly configYml: string;
  readonly objectiveMd: string;
  readonly planJson: string;
  readonly assumptionsMd: string;
  readonly stateDir: string;
  readonly eventsDir: string;
  readonly eventsDb: string;
  readonly eventsJsonl: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  readonly reviewsDir: string;
  readonly checksDir: string;
  /** Output of the optional UI smoke command (text logs, NOT screenshots). */
  readonly uiSmokeDir: string;
  readonly contextDir: string;
  readonly worktreesDir: string;
  readonly reportsDir: string;
  readonly controlDir: string;
  /** Single-writer run lock (PID file) — see process/pidfile.ts. */
  readonly runLock: string;
}

export function projectPaths(root: string): ProjectPaths {
  const dir = join(root, AGENT_DIR);
  const eventsDir = join(dir, 'events');
  const artifactsDir = join(dir, 'artifacts');
  return {
    root,
    dir,
    configYml: join(dir, 'config.yml'),
    objectiveMd: join(dir, 'objective.md'),
    planJson: join(dir, 'plan.json'),
    assumptionsMd: join(dir, 'assumptions.md'),
    stateDir: join(dir, 'state'),
    eventsDir,
    eventsDb: join(eventsDir, 'events.db'),
    eventsJsonl: join(eventsDir, 'events.jsonl'),
    artifactsDir,
    logsDir: join(artifactsDir, 'logs'),
    reviewsDir: join(artifactsDir, 'reviews'),
    checksDir: join(artifactsDir, 'checks'),
    uiSmokeDir: join(artifactsDir, 'ui-smoke'),
    contextDir: join(artifactsDir, 'context'),
    worktreesDir: join(dir, 'worktrees'),
    reportsDir: join(dir, 'reports'),
    controlDir: join(dir, 'control'),
    runLock: join(dir, 'control', 'run.pid'),
  };
}

/** Create the full directory tree and write the protective inner .gitignore.
 *
 * Every directory is created owner-only (0700) where the OS enforces POSIX
 * permissions, so run state (events, logs, context packs, reports, control
 * intent) is not world-readable on a shared host. On Windows the mode is a no-op
 * (documented in docs/security-model.md). */
export function ensureLayout(paths: ProjectPaths): void {
  for (const d of [
    paths.dir,
    paths.stateDir,
    paths.eventsDir,
    paths.artifactsDir,
    paths.logsDir,
    paths.reviewsDir,
    paths.checksDir,
    paths.uiSmokeDir,
    paths.contextDir,
    paths.worktreesDir,
    paths.reportsDir,
    paths.controlDir,
  ]) {
    ensureDir(d, { mode: PRIVATE_DIR_MODE });
  }
  const gi = join(paths.dir, '.gitignore');
  if (!fileExists(gi)) {
    // Keep durable, human-meaningful artifacts (config, objective, plan) but
    // ignore transient/large/sensitive run state by default.
    atomicWrite(
      gi,
      [
        '# Written by agent-loop. Transient and potentially sensitive run state.',
        'state/',
        'events/',
        'artifacts/',
        'control/',
        'worktrees/',
        'reports/',
        '',
        '# Keep these tracked if you want plan provenance in VCS:',
        '!config.yml',
        '!objective.md',
        '!plan.json',
        '!assumptions.md',
        '',
      ].join('\n'),
    );
  }
}

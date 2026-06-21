/**
 * Session factory: assembles the shared, long-lived dependencies a run needs
 * (paths, config, event store, provider registry, git, process manager, redactor,
 * logger) so the CLI commands and the engine all build them the same way.
 */
import { ZodError } from 'zod';
import { statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, ensureLayout, type ProjectPaths } from '../util/paths.js';
import { atomicWriteJson, atomicWrite, readJson, fileExists, PRIVATE_FILE_MODE } from '../util/fs.js';
import { Logger } from '../util/logger.js';
import { Redactor } from '../security/redact.js';
import { collectSecretValues } from '../security/env.js';
import { systemClock, type Clock } from '../util/clock.js';
import { SqliteEventStore } from '../events/store.js';
import { ProcessManager } from '../process/manager.js';
import { GitRepo } from '../git/repo.js';
import { loadConfig } from '../config/load.js';
import { createRegistry, ProviderRegistry } from '../providers/registry.js';
import { PlanSchema, ObjectiveSchema, type Plan, type Objective } from '../domain/schemas.js';
import type { Config } from '../config/config.js';

export interface Session {
  root: string;
  paths: ProjectPaths;
  config: Config;
  configSources: string[];
  store: SqliteEventStore;
  registry: ProviderRegistry;
  pm: ProcessManager;
  redactor: Redactor;
  logger: Logger;
  clock: Clock;
  git: GitRepo;
  close(): void;
}

export interface OpenSessionOptions {
  root: string;
  cliOverrides?: Record<string, unknown>;
  clock?: Clock;
  skipUserConfig?: boolean;
  /** Mirror human-readable logs to this stream (e.g. process.stderr). */
  logStream?: NodeJS.WritableStream | undefined;
}

export function openSession(opts: OpenSessionOptions): Session {
  const clock = opts.clock ?? systemClock;
  const paths = projectPaths(opts.root);
  ensureLayout(paths);
  // Make git treat .agent-loop as ignored locally (without touching the user's
  // tracked .gitignore), so our run metadata never dirties the tree or gets wiped
  // by `git clean` during rollback.
  ensureGitExcludesAgentDir(opts.root);

  const { config, sources } = loadConfig({
    root: opts.root,
    ...(opts.cliOverrides ? { cliOverrides: opts.cliOverrides } : {}),
    ...(opts.skipUserConfig ? { skipUserConfig: true } : {}),
  });

  const redactor = new Redactor(collectSecretValues(process.env));
  const logger = new Logger(
    {
      level: config.logging.level,
      filePath: paths.logsDir + '/agent-loop.log',
      stream: opts.logStream,
      redactor,
      clock,
    },
    { component: 'session' },
  );

  const store = new SqliteEventStore(paths.eventsDb, { clock, jsonlMirrorPath: paths.eventsJsonl, redactor });
  const pm = new ProcessManager();
  const git = new GitRepo(opts.root, pm, redactor);
  const registry = createRegistry(config, opts.root, pm);

  return {
    root: opts.root,
    paths,
    config,
    configSources: sources,
    store,
    registry,
    pm,
    redactor,
    logger,
    clock,
    git,
    close(): void {
      store.close();
    },
  };
}

/** Add `.agent-loop/` to .git/info/exclude (local, uncommitted) if not present. */
function ensureGitExcludesAgentDir(root: string): void {
  const gitDir = join(root, '.git');
  try {
    if (!statSync(gitDir).isDirectory()) return; // worktree/.git file — common dir handles it
  } catch {
    return; // not a git repo yet
  }
  const infoDir = join(gitDir, 'info');
  const excludePath = join(infoDir, 'exclude');
  let content = '';
  try {
    if (existsSync(excludePath)) content = readFileSync(excludePath, 'utf8');
  } catch {
    return;
  }
  if (content.split('\n').some((l) => l.trim() === '.agent-loop/' || l.trim() === '.agent-loop')) return;
  try {
    mkdirSync(infoDir, { recursive: true });
    const next = content.length === 0 ? '' : content.endsWith('\n') ? content : content + '\n';
    writeFileSync(excludePath, next + '.agent-loop/\n');
  } catch {
    // best effort; the `-e .agent-loop` guard on clean still protects us
  }
}

// --- plan / objective persistence -------------------------------------------

export function savePlan(paths: ProjectPaths, plan: Plan): void {
  atomicWriteJson(paths.planJson, plan);
}

export function loadPlan(paths: ProjectPaths): Plan | undefined {
  if (!fileExists(paths.planJson)) return undefined;
  try {
    return PlanSchema.parse(readJson(paths.planJson));
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`plan.json is invalid: ${err.issues.map((i) => i.message).join('; ')}`);
    }
    throw err;
  }
}

export interface RunMeta {
  runId: string;
  planId: string;
  branch?: string;
  baselineSha?: string;
  createdAt: string;
}

export function saveRunMeta(paths: ProjectPaths, meta: RunMeta): void {
  atomicWriteJson(paths.stateDir + '/run.json', meta, { mode: PRIVATE_FILE_MODE });
}

export function loadRunMeta(paths: ProjectPaths): RunMeta | undefined {
  const path = paths.stateDir + '/run.json';
  if (!fileExists(path)) return undefined;
  try {
    return readJson<RunMeta>(path);
  } catch {
    return undefined;
  }
}

export function saveObjective(paths: ProjectPaths, objective: Objective): void {
  // Human-readable objective.md + assumptions.md, both derived from the validated
  // objective (never agent-authored).
  const parsed = ObjectiveSchema.parse(objective);
  const md = [
    `# Objective`,
    ``,
    `## Goal`,
    parsed.goal,
    ``,
    ...(parsed.background ? ['## Background', parsed.background, ''] : []),
    `## Success criteria`,
    ...parsed.successCriteria.map((c) => `- (${c.type}) ${c.description}`),
    ``,
    `## Constraints`,
    ...(parsed.constraints.length ? parsed.constraints.map((c) => `- ${c}`) : ['- (none)']),
    ``,
    `## Non-goals`,
    ...(parsed.nonGoals.length ? parsed.nonGoals.map((c) => `- ${c}`) : ['- (none)']),
    ``,
    `## Final completion criteria`,
    ...parsed.finalCompletionCriteria.map((c) => `- ${c}`),
    ``,
  ].join('\n');
  atomicWrite(paths.objectiveMd, md);
  atomicWrite(
    paths.assumptionsMd,
    [`# Recorded assumptions`, ``, ...(parsed.assumptions.length ? parsed.assumptions.map((a) => `- ${a}`) : ['- (none)']), ''].join('\n'),
  );
}

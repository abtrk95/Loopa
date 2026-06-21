/**
 * `agent-loop pr create` — open a draft pull request for the run branch via `gh`.
 * Pushing happens only with --push; we never auto-merge or deploy.
 */
import { SqliteEventStore } from '../../events/store.js';
import { ProcessManager } from '../../process/manager.js';
import { projectPaths } from '../../util/paths.js';
import { loadConfig } from '../../config/load.js';
import { loadRunMeta } from '../../orchestrator/session.js';
import { project } from '../../events/projection.js';
import { createPullRequest } from '../../github/pr.js';
import { ControlError } from '../../domain/errors.js';
import { flagBool, flagStr, resolveRoot, type ParsedArgs } from '../args.js';

export async function cmdPr(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== 'create') {
    process.stdout.write('Usage: agent-loop pr create [--push] [--no-draft] [--base <branch>] [--remote <name>]\n');
    return sub ? 1 : 0;
  }
  const root = resolveRoot(args);
  const paths = projectPaths(root);
  const meta = loadRunMeta(paths);
  if (!meta?.branch) throw new ControlError('no run branch found; run a plan/run first.');
  const config = loadConfig({ root }).config;
  const store = new SqliteEventStore(paths.eventsDb);
  try {
    const snap = project(store.read(meta.runId));
    const result = await createPullRequest(
      {
        root,
        branch: meta.branch,
        remote: flagStr(args, 'remote') ?? config.github.remote,
        draft: !flagBool(args, 'no-draft') && config.github.draftPr,
        push: flagBool(args, 'push'),
        ...(flagStr(args, 'base') ? { baseBranch: flagStr(args, 'base')! } : {}),
      },
      snap,
      new ProcessManager(),
    );
    // Record the action in the run's event log (audit trail).
    store.append({
      runId: meta.runId,
      type: 'PR_CREATED',
      source: 'github',
      idempotencyKey: `pr:${meta.branch}:${result.url}`,
      payload: { url: result.url, created: result.created, branch: meta.branch },
    });
    process.stdout.write(`${result.created ? 'Created' : 'Existing'} PR: ${result.url}\n`);
    return 0;
  } finally {
    store.close();
  }
}

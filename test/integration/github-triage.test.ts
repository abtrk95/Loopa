/**
 * GitHub triage + Kanban — hermetic validation against a `gh` stub on PATH.
 *
 * Proves, without touching GitHub, that:
 *  - issues classify as ready / needs-info / too-risky / unsupported,
 *  - dry-run performs NO writes; apply writes labels (and comments),
 *  - clarification comments are posted for unclear issues in apply mode,
 *  - project (v2) sync works and degrades gracefully when no board exists,
 *  - PR upsert edits an existing PR instead of duplicating,
 *  - watch --once is idempotent, polling respects max-iterations, and a second
 *    watcher is refused (duplicate-run prevention),
 *  - NO merge / deploy / close verb is ever invoked.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../../src/process/manager.js';
import { GhClient } from '../../src/github/client.js';
import { classifyIssue, triageRepo } from '../../src/github/triage.js';
import { detectProject, syncIssueStatus } from '../../src/github/project.js';
import { updatePullRequest } from '../../src/github/pr.js';
import { watchOnce, watchLoop } from '../../src/github/watch.js';
import { acquireRunLock, releaseRunLock } from '../../src/process/pidfile.js';
import { project } from '../../src/events/projection.js';
import { defaultConfig } from '../../src/config/config.js';

const pm = new ProcessManager();
const cfg = defaultConfig().github;
const REPO = 'o/r';
const dirs: string[] = [];
let savedPath: string | undefined;

interface Fixtures {
  issues?: unknown[];
  issue?: unknown;
  prExisting?: Array<{ url: string; number: number }>;
  project?: unknown;
  item?: unknown;
}

function ghStub(fx: Fixtures = {}): { dir: string; log: () => string[]; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'al-ght-'));
  dirs.push(dir);
  const root = mkdtempSync(join(tmpdir(), 'al-ghroot-'));
  dirs.push(root);
  const logFile = join(dir, 'gh.log');
  const write = (name: string, val: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(val));
    return p;
  };
  const issuesFile = write('issues.json', fx.issues ?? []);
  const issueFile = write('issue.json', fx.issue ?? {});
  const prFile = write('pr.json', fx.prExisting ?? []);
  const projectFile = write('project.json', fx.project ?? { data: { repository: { projectsV2: { nodes: [] } } } });
  const itemFile = write('item.json', fx.item ?? { data: { repository: { issue: { projectItems: { nodes: [] } } } } });

  const script = [
    '#!/bin/sh',
    // One flattened line per invocation (newlines in --body squashed) so a verb +
    // its flags never split across log lines.
    `printf '%s' "$*" | tr '\\n\\r' '  ' >> "${logFile}"`,
    `printf '\\n' >> "${logFile}"`,
    'case "$1 $2" in',
    `  "issue list") cat "${issuesFile}" ;;`,
    `  "issue view") cat "${issueFile}" ;;`,
    '  "issue edit") : ;;',
    '  "issue comment") : ;;',
    `  "pr list") cat "${prFile}" ;;`,
    `  "pr create") printf '%s\\n' "https://github.com/o/r/pull/42" ;;`,
    '  "pr edit") : ;;',
    '  "api graphql")',
    '    case "$*" in',
    `      *updateProjectV2ItemFieldValue*) printf '%s\\n' '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_x"}}}}' ;;`,
    `      *projectItems*) cat "${itemFile}" ;;`,
    `      *projectsV2*) cat "${projectFile}" ;;`,
    `      *) printf '%s\\n' '{}' ;;`,
    '    esac ;;',
    `  *) printf '%s\\n' '{}' ;;`,
    'esac',
    'exit 0',
  ].join('\n');
  const gh = join(dir, 'gh');
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  return {
    dir,
    root,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

function use(stub: { dir: string }): void {
  process.env['PATH'] = `${stub.dir}:${savedPath}`;
}

beforeEach(() => {
  savedPath = process.env['PATH'];
});
afterEach(() => {
  process.env['PATH'] = savedPath;
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const READY_ISSUE = {
  number: 1,
  title: 'Add CSV export button',
  body: 'We need CSV export.\n- [ ] add button\n- [x] write encoder\nThis is well specified and safe.',
  labels: [{ name: 'agent-loop:ready' }],
  url: 'https://github.com/o/r/issues/1',
  state: 'OPEN',
};
const VAGUE_ISSUE = { number: 2, title: 'Add something', body: 'x', labels: [{ name: 'agent-loop:ready' }], url: 'u', state: 'OPEN' };
const RISKY_ISSUE = { number: 3, title: 'Migrate auth and payment database', body: 'rework the production auth + payment schema', labels: [{ name: 'agent-loop:ready' }], url: 'u', state: 'OPEN' };
const QUESTION_ISSUE = { number: 4, title: 'How do I run this?', body: 'short', labels: [{ name: 'agent-loop:ready' }], url: 'u', state: 'OPEN' };
const UNLABELED = { number: 5, title: 'Add export', body: 'detailed enough body to plan from with specifics about formats and edge cases', labels: [], url: 'u', state: 'OPEN' };

describe('classifyIssue', () => {
  it('classifies a specified issue with acceptance criteria as ready', () => {
    const r = classifyIssue({ number: 1, title: 'Add CSV export', body: 'detail\n- [ ] a\n- [ ] b', labels: [] }, 'quick');
    expect(r.status).toBe('ready');
  });
  it('classifies a thin actionable issue as needs-info with clarifications', () => {
    const r = classifyIssue({ number: 2, title: 'Add export feature', body: 'x', labels: [] }, 'standard');
    expect(r.status).toBe('needs-info');
    expect(r.clarifications.length).toBeGreaterThan(0);
  });
  it('classifies a high-risk under-specified issue as too-risky', () => {
    const r = classifyIssue({ number: 3, title: 'Migrate production auth + payment DB', body: 'rework schema', labels: [] }, 'standard');
    expect(r.status).toBe('too-risky');
  });
  it('classifies a question as unsupported', () => {
    const r = classifyIssue({ number: 4, title: 'How do I run this?', body: 'short', labels: [] }, 'quick');
    expect(r.status).toBe('unsupported');
  });
  it('classifies a vague improvement request as needs-info (actionable but thin), not unsupported', () => {
    // "improve / make it better" are actionable intents that need clarification — the
    // canonical needs-info case (regression for the Phase-6 misclassification).
    const r = classifyIssue(
      { number: 5, title: 'Make the dashboard better', body: 'Improve the dashboard and make it more useful.', labels: [] },
      'standard',
    );
    expect(r.status).toBe('needs-info');
    expect(r.clarifications.length).toBeGreaterThan(0);
  });
});

describe('triageRepo', () => {
  it('dry-run performs NO writes (only reads in the gh log)', async () => {
    const stub = ghStub({ issues: [READY_ISSUE, VAGUE_ISSUE] });
    use(stub);
    const client = new GhClient(stub.root, { dryRun: true, pm });
    const report = await triageRepo(client, cfg, { repo: REPO, mode: 'quick', comment: true, onlyTriggered: true });
    expect(report.dryRun).toBe(true);
    expect(report.results.length).toBe(2);
    const calls = stub.log();
    expect(calls.some((c) => c.startsWith('issue list'))).toBe(true);
    expect(calls.some((c) => c.startsWith('issue edit'))).toBe(false); // no label writes
    expect(calls.some((c) => c.startsWith('issue comment'))).toBe(false); // no comments
  });

  it('apply mode writes labels and comments clarifications for unclear issues', async () => {
    const stub = ghStub({ issues: [READY_ISSUE, VAGUE_ISSUE] });
    use(stub);
    const client = new GhClient(stub.root, { dryRun: false, pm });
    const report = await triageRepo(client, cfg, { repo: REPO, mode: 'standard', comment: true, onlyTriggered: true });
    const calls = stub.log();
    expect(calls.some((c) => c.startsWith('issue edit'))).toBe(true); // labels applied
    expect(calls.some((c) => c.startsWith('issue comment'))).toBe(true); // clarifications posted
    const vague = report.results.find((r) => r.number === 2)!;
    expect(vague.status).toBe('needs-info');
    expect(vague.commented).toBe(true);
  });

  it('ignores issues without a trigger label unless onlyTriggered=false', async () => {
    const stub = ghStub({ issues: [UNLABELED] });
    use(stub);
    const onlyTriggered = await triageRepo(new GhClient(stub.root, { dryRun: true, pm }), cfg, { repo: REPO, mode: 'quick', comment: false, onlyTriggered: true });
    expect(onlyTriggered.considered).toBe(0);
    expect(onlyTriggered.skipped).toBe(1);

    const stub2 = ghStub({ issues: [UNLABELED] });
    use(stub2);
    const all = await triageRepo(new GhClient(stub2.root, { dryRun: true, pm }), cfg, { repo: REPO, mode: 'quick', comment: false, onlyTriggered: false });
    expect(all.considered).toBe(1);
  });

  it('never invokes a merge / deploy / close verb', async () => {
    const stub = ghStub({ issues: [READY_ISSUE, VAGUE_ISSUE, RISKY_ISSUE, QUESTION_ISSUE] });
    use(stub);
    await triageRepo(new GhClient(stub.root, { dryRun: false, pm }), cfg, { repo: REPO, mode: 'strict', comment: true, onlyTriggered: true });
    const calls = stub.log();
    for (const c of calls) {
      // Assert on the VERB (first two tokens) — body prose may legitimately mention
      // "never auto-merges or deploys".
      const verb = c.split(/\s+/).slice(0, 2).join(' ');
      expect(/merge|deploy/.test(verb), `unexpected verb: ${verb}`).toBe(false);
      expect(verb).not.toBe('issue close');
    }
  });
});

describe('project sync', () => {
  const PROJECT_FIXTURE = {
    data: { repository: { projectsV2: { nodes: [{ id: 'PVT_1', title: 'Board', number: 7, field: { id: 'F_status', options: [{ id: 'opt_ready', name: 'Ready' }, { id: 'opt_run', name: 'Running' }, { id: 'opt_done', name: 'Done' }] } }] } } },
  };
  const ITEM_FIXTURE = { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_1', project: { id: 'PVT_1' } }] } } } } };

  it('detects a linked project and its status options', async () => {
    const stub = ghStub({ project: PROJECT_FIXTURE });
    use(stub);
    const info = await detectProject(new GhClient(stub.root, { dryRun: true, pm }), REPO, { ...cfg, project: { ...cfg.project, enabled: true } });
    expect(info?.title).toBe('Board');
    expect(Object.keys(info!.options)).toContain('Ready');
  });

  it('moves a card to a column in apply mode', async () => {
    const stub = ghStub({ project: PROJECT_FIXTURE, item: ITEM_FIXTURE });
    use(stub);
    const client = new GhClient(stub.root, { dryRun: false, pm });
    const res = await syncIssueStatus(client, REPO, { ...cfg, project: { ...cfg.project, enabled: true } }, 1, 'Ready');
    expect(res.ok).toBe(true);
    expect(stub.log().some((c) => c.includes('updateProjectV2ItemFieldValue'))).toBe(true);
  });

  it('degrades gracefully (warning, no throw) when no project exists', async () => {
    const stub = ghStub({ project: { data: { repository: { projectsV2: { nodes: [] } } } } });
    use(stub);
    const res = await syncIssueStatus(new GhClient(stub.root, { dryRun: false, pm }), REPO, { ...cfg, project: { ...cfg.project, enabled: true } }, 1, 'Ready');
    expect(res.ok).toBe(false);
    expect(res.warning).toMatch(/no linked GitHub Project/i);
  });
});

describe('PR upsert', () => {
  const snap = project([]);
  it('edits an existing PR instead of creating a duplicate', async () => {
    const stub = ghStub({ prExisting: [{ url: 'https://github.com/o/r/pull/7', number: 7 }] });
    use(stub);
    const res = await updatePullRequest({ root: stub.root, branch: 'agent-loop/x', remote: 'origin', draft: true, push: false, sourceIssue: 1 }, snap, pm);
    expect(res.updated).toBe(true);
    expect(res.url).toBe('https://github.com/o/r/pull/7');
    const calls = stub.log();
    expect(calls.some((c) => c.startsWith('pr edit'))).toBe(true);
    expect(calls.some((c) => c.startsWith('pr create'))).toBe(false);
  });

  it('creates a draft PR when none exists', async () => {
    const stub = ghStub({ prExisting: [] });
    use(stub);
    const res = await updatePullRequest({ root: stub.root, branch: 'agent-loop/x', remote: 'origin', draft: true, push: false }, snap, pm);
    expect(res.created).toBe(true);
    expect(stub.log().some((c) => c.startsWith('pr create') && c.includes('--draft'))).toBe(true);
  });
});

describe('watch', () => {
  function watchDir(): { agentDir: string; controlDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'al-ghwatch-'));
    dirs.push(dir);
    const agentDir = join(dir, '.agent-loop');
    const controlDir = join(agentDir, 'control');
    mkdirSync(controlDir, { recursive: true });
    return { agentDir, controlDir };
  }

  it('watch --once is idempotent (second pass processes nothing new)', async () => {
    const stub = ghStub({ issues: [READY_ISSUE] });
    use(stub);
    const paths = watchDir();
    const client = new GhClient(stub.root, { dryRun: false, pm });
    const opts = { repo: REPO, mode: 'quick' as const, comment: false, onlyTriggered: true, syncProject: false };
    const first = await watchOnce(client, cfg, paths, opts);
    expect(first.processed).toBe(1);
    const second = await watchOnce(client, cfg, paths, opts);
    expect(second.processed).toBe(0); // unchanged classification → skipped
  });

  it('polling respects max-iterations (fake sleep)', async () => {
    const stub = ghStub({ issues: [READY_ISSUE] });
    use(stub);
    const paths = watchDir();
    const client = new GhClient(stub.root, { dryRun: true, pm });
    const result = await watchLoop(client, cfg, paths, {
      repo: REPO,
      mode: 'quick',
      comment: false,
      onlyTriggered: true,
      syncProject: false,
      intervalSeconds: 300,
      maxIterations: 3,
      sleep: async () => {},
    });
    expect(result.iterations).toBe(3);
  });

  it('refuses to start a second watcher (duplicate-run prevention)', async () => {
    const stub = ghStub({ issues: [READY_ISSUE] });
    use(stub);
    const paths = watchDir();
    const lockFile = join(paths.controlDir, 'github-watch.pid');
    // Simulate another LIVE watcher (parent pid is alive, and != our pid).
    acquireRunLock(lockFile, 'github-watch', Date.now(), process.ppid);
    try {
      await expect(
        watchLoop(new GhClient(stub.root, { dryRun: true, pm }), cfg, paths, {
          repo: REPO,
          mode: 'quick',
          comment: false,
          onlyTriggered: true,
          syncProject: false,
          intervalSeconds: 1,
          maxIterations: 1,
          sleep: async () => {},
        }),
      ).rejects.toThrow(/another agent-loop github watch is active/i);
    } finally {
      releaseRunLock(lockFile, process.ppid);
    }
  });
});

describe('no auto-merge / auto-deploy / close construction in the github modules', () => {
  it('source modules contain no merge/deploy/close verb construction', () => {
    for (const rel of ['client.ts', 'triage.ts', 'project.ts', 'watch.ts', 'labels.ts', 'pr.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../../src/github/${rel}`, import.meta.url)), 'utf8');
      expect(/pr['"\s,]+merge/.test(src), `${rel} must not build a pr merge`).toBe(false);
      expect(/['"]deploy['"]/.test(src), `${rel} must not reference a deploy verb`).toBe(false);
      expect(/issue['"\s,]+close/.test(src), `${rel} must not build an issue close`).toBe(false);
    }
  });
});

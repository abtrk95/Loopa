/**
 * Combined GitHub → plan → run → PR flow, fully hermetic.
 *
 * Exercises the real `agent-loop github` commands against a `gh` stub on PATH and
 * the deterministic fake provider, proving the end-to-end chain:
 *
 *   stub issue → triage (ready) → import → interview (enrich) → plan
 *     → run fake provider → verifier passes → scoped commit
 *     → draft PR (stub) → update labels + project column → final report
 *
 * with the local verifier authoritative and NO merge/deploy anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.js';
import { cmdGithub } from '../../src/cli/commands/github.js';
import { triageRepo } from '../../src/github/triage.js';
import { GhClient } from '../../src/github/client.js';
import { ProcessManager } from '../../src/process/manager.js';
import { projectPaths } from '../../src/util/paths.js';
import { loadRunMeta, loadPlan } from '../../src/orchestrator/session.js';
import { SqliteEventStore } from '../../src/events/store.js';
import { project } from '../../src/events/projection.js';
import { defaultConfig } from '../../src/config/config.js';
import { tempRepo, writeFakeScript, cleanupRepos } from '../helpers.js';

const pm = new ProcessManager();
const dirs: string[] = [];
let savedPath: string | undefined;
let savedConfig: string | undefined;

const READY_ISSUE = {
  number: 10,
  title: 'Add a CSV export helper',
  body: 'Add a small CSV export helper module.\n- [ ] export rows to CSV\n- [ ] cover with a test\nWell specified and low risk.',
  labels: [{ name: 'agent-loop:ready' }],
  url: 'https://github.com/o/r/issues/10',
  state: 'OPEN',
};

const PROJECT_FIXTURE = {
  data: {
    repository: {
      projectsV2: {
        nodes: [
          {
            id: 'PVT_1',
            title: 'Board',
            number: 7,
            field: {
              id: 'F_status',
              options: ['Inbox', 'Needs Info', 'Ready', 'Planning', 'Running', 'Blocked', 'Review', 'Done'].map((name, i) => ({ id: `opt_${i}`, name })),
            },
          },
        ],
      },
    },
  },
};
const ITEM_FIXTURE = { data: { repository: { issue: { projectItems: { nodes: [{ id: 'PVTI_1', project: { id: 'PVT_1' } }] } } } } };

function ghStub(): { dir: string; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'al-ghe2e-'));
  dirs.push(dir);
  const logFile = join(dir, 'gh.log');
  const w = (name: string, val: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(val));
    return p;
  };
  const issuesFile = w('issues.json', [READY_ISSUE]);
  const issueFile = w('issue.json', READY_ISSUE);
  const projectFile = w('project.json', PROJECT_FIXTURE);
  const itemFile = w('item.json', ITEM_FIXTURE);
  const script = [
    '#!/bin/sh',
    `printf '%s' "$*" | tr '\\n\\r' '  ' >> "${logFile}"`,
    `printf '\\n' >> "${logFile}"`,
    'case "$1 $2" in',
    `  "issue list") cat "${issuesFile}" ;;`,
    `  "issue view") cat "${issueFile}" ;;`,
    '  "issue edit") : ;;',
    '  "issue comment") : ;;',
    `  "pr list") printf '%s\\n' '[]' ;;`,
    `  "pr create") printf '%s\\n' 'https://github.com/o/r/pull/99' ;;`,
    '  "pr edit") : ;;',
    '  "api graphql")',
    '    case "$*" in',
    `      *updateProjectV2ItemFieldValue*) printf '%s\\n' '{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_1"}}}}' ;;`,
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
  return { dir, log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

beforeEach(() => {
  savedPath = process.env['PATH'];
  savedConfig = process.env['AGENT_LOOP_CONFIG'];
  // Neutralize any real user config so the CLI path is deterministic.
  const empty = mkdtempSync(join(tmpdir(), 'al-cfg-'));
  dirs.push(empty);
  const cfgFile = join(empty, 'config.yml');
  writeFileSync(cfgFile, 'version: 1\n');
  process.env['AGENT_LOOP_CONFIG'] = cfgFile;
});
afterEach(() => {
  process.env['PATH'] = savedPath;
  if (savedConfig === undefined) delete process.env['AGENT_LOOP_CONFIG'];
  else process.env['AGENT_LOOP_CONFIG'] = savedConfig;
  cleanupRepos();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('combined GitHub → plan → run → PR (hermetic)', () => {
  it('triages an issue as ready before any work starts', async () => {
    const stub = ghStub();
    process.env['PATH'] = `${stub.dir}:${savedPath}`;
    const root = tempRepo();
    const report = await triageRepo(new GhClient(root, { dryRun: true, pm }), defaultConfig().github, {
      repo: 'o/r',
      mode: 'quick',
      comment: false,
      onlyTriggered: true,
    });
    expect(report.results.find((r) => r.number === 10)?.status).toBe('ready');
    // dry-run: nothing was started, no writes.
    expect(stub.log().some((c) => c.startsWith('issue edit'))).toBe(false);
  });

  it('runs the full chain via `github run-issue` and ends verified-complete with a draft PR', async () => {
    const stub = ghStub();
    process.env['PATH'] = `${stub.dir}:${savedPath}`;
    const root = tempRepo();
    // Deterministic implementation for the single slice the issue produces.
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/csv.js': 'export const toCsv = (r) => r.join(",");\n' } } }, reviews: {} });

    // Interview enrichment supplies an extra forbidden path; --answers keeps it hermetic.
    const answers = join(stub.dir, 'answers.json');
    writeFileSync(answers, JSON.stringify({ forbiddenPaths: ['docs/**'], nonGoals: ['xlsx export'] }));

    const args = parseArgs([
      'github', 'run-issue',
      '--repo', 'o/r',
      '--issue', '10',
      '--auto', '--apply', '--pr', '--project',
      '--interview', 'quick',
      '--answers', answers,
      '--root', root,
    ]);
    const code = await cmdGithub(args);
    expect(code).toBe(0); // COMPLETED

    const paths = projectPaths(root);

    // Plan reflects the import + interview enrichment.
    const plan = loadPlan(paths)!;
    expect(plan.slices[0]!.id).toBe('S-001');
    expect(plan.riskPolicy.globalForbiddenPaths).toContain('docs/**'); // from interview
    expect(plan.riskPolicy.globalForbiddenPaths).toContain('.env'); // built-in preserved
    expect(plan.nonGoals).toContain('xlsx export');
    expect(plan.assumptions.some((a) => /interview/i.test(a))).toBe(true);

    // Run is verified-complete (verifier authority, not agent claims).
    const meta = loadRunMeta(paths)!;
    const store = new SqliteEventStore(paths.eventsDb);
    try {
      const snap = project(store.read(meta.runId));
      expect(snap.runState).toBe('COMPLETED');
      expect(snap.verifiedCompleted).toBe(1);
      expect(snap.totalSlices).toBe(1);
      expect(snap.lastCommit?.sha).toBeTruthy(); // a real scoped commit exists
    } finally {
      store.close();
    }

    // GitHub side effects happened, and ONLY safe ones.
    const calls = stub.log();
    const verbs = calls.map((c) => c.split(/\s+/).slice(0, 2).join(' '));
    expect(verbs.some((v) => v === 'issue edit')).toBe(true); // status labels applied
    expect(calls.some((c) => c.startsWith('pr create') && c.includes('--draft'))).toBe(true); // draft PR
    expect(calls.some((c) => c.startsWith('pr create') && /Refs #10/.test(c))).toBe(true); // linked to issue
    expect(calls.some((c) => c.includes('updateProjectV2ItemFieldValue'))).toBe(true); // board moved
    for (const v of verbs) {
      expect(/merge|deploy/.test(v), `unexpected verb: ${v}`).toBe(false);
      expect(v).not.toBe('issue close');
    }

    // A run report was generated.
    expect(existsSync(join(paths.reportsDir, 'report.md'))).toBe(true);
  });
});

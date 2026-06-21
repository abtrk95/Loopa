/**
 * GitHub integration — live-safe validation (T6).
 *
 * Hermetic: a `gh` stub on PATH records every invocation and returns canned JSON,
 * so we can prove — without touching GitHub — that:
 *   - duplicate PRs are prevented (existing PR → no `gh pr create`),
 *   - PRs are created as drafts by default, and `--no-draft` removes the flag,
 *   - pushing happens ONLY with `--push` (verified against a real local remote),
 *   - issue import shells out read-only and parses title/body/comments,
 *   - NO `gh pr merge` / merge / deploy verb is ever invoked, and there is no
 *     auto-merge/auto-deploy code path in the github module.
 *
 * Opt-in: a documented, read-only live check against a throwaway repo, gated on
 *   AGENT_LOOP_GH_LIVE=1 AGENT_LOOP_GH_LIVE_REPO=owner/repo
 * (and a further AGENT_LOOP_GH_LIVE_CREATE=1 to actually open+close a draft PR).
 * See docs/github-integration.md → "Optional live test".
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProcessManager } from '../../src/process/manager.js';
import { createPullRequest } from '../../src/github/pr.js';
import { importIssue, issueToText } from '../../src/github/issue.js';
import { project } from '../../src/events/projection.js';
import { tempRepo, cleanupRepos, git } from '../helpers.js';

const pm = new ProcessManager();
const stubDirs: string[] = [];
let savedPath: string | undefined;

function ghStub(): { dir: string; log: () => string[]; setExisting: (v: boolean) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'al-gh-'));
  stubDirs.push(dir);
  const logFile = join(dir, 'gh.log');
  const file = join(dir, 'gh');
  // Use `printf '%s\n'` (not echo) so backslash escapes in the JSON args are
  // preserved verbatim — macOS /bin/sh `echo` would turn `\n` into a real newline
  // and corrupt the JSON.
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      // One line per invocation: "<verb> :: <full args, newlines squashed>".
      // The verb (argv[0] argv[1]) is what we assert merge/deploy safety on; the
      // full args (for flag checks) are kept after the delimiter with newlines
      // flattened so a multi-line --body never splits into fake log lines.
      `printf '%s :: ' "$1 $2" >> "${logFile}"`,
      `printf '%s' "$*" | tr '\\n\\r' '  ' >> "${logFile}"`,
      `printf '\\n' >> "${logFile}"`,
      'case "$1 $2" in',
      '  "pr list")',
      `    if [ "$GH_STUB_EXISTING" = "1" ]; then printf '%s\\n' '[{"url":"https://github.com/o/r/pull/7"}]'; else printf '%s\\n' '[]'; fi ;;`,
      `  "pr create") printf '%s\\n' "https://github.com/o/r/pull/42" ;;`,
      `  "issue view") printf '%s\\n' '{"title":"Add CSV export","body":"Export rows.\\n- [ ] add button\\n- [x] write encoder","comments":[{"author":{"login":"alice"},"body":"add tests please"}]}' ;;`,
      `  *) printf '%s\\n' "{}" ;;`,
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
  return {
    dir,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []),
    setExisting: (v) => {
      if (v) process.env['GH_STUB_EXISTING'] = '1';
      else delete process.env['GH_STUB_EXISTING'];
    },
  };
}

beforeEach(() => {
  savedPath = process.env['PATH'];
});
afterEach(() => {
  process.env['PATH'] = savedPath;
  delete process.env['GH_STUB_EXISTING'];
  cleanupRepos();
});
afterAll(() => {
  for (const d of stubDirs) rmSync(d, { recursive: true, force: true });
});

const snapshot = project([]); // minimal snapshot is sufficient for title/body

describe('createPullRequest (hermetic gh stub)', () => {
  it('prevents duplicate PRs (existing PR → no create)', async () => {
    const root = tempRepo();
    const gh = ghStub();
    gh.setExisting(true);
    process.env['PATH'] = `${gh.dir}:${savedPath}`;
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const res = await createPullRequest({ root, branch, remote: 'origin', draft: true, push: false }, snapshot, pm);
    expect(res.created).toBe(false);
    expect(res.url).toBe('https://github.com/o/r/pull/7');
    const calls = gh.log();
    expect(calls.some((c) => c.startsWith('pr list'))).toBe(true);
    expect(calls.some((c) => c.startsWith('pr create'))).toBe(false); // no second PR
  });

  it('creates a DRAFT PR by default; --no-draft drops the flag', async () => {
    const root = tempRepo();
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

    const ghDraft = ghStub();
    process.env['PATH'] = `${ghDraft.dir}:${savedPath}`;
    const draft = await createPullRequest({ root, branch, remote: 'origin', draft: true, push: false }, snapshot, pm);
    expect(draft.created).toBe(true);
    expect(ghDraft.log().some((c) => c.startsWith('pr create') && c.includes('--draft'))).toBe(true);

    const ghNoDraft = ghStub();
    process.env['PATH'] = `${ghNoDraft.dir}:${savedPath}`;
    await createPullRequest({ root, branch, remote: 'origin', draft: false, push: false }, snapshot, pm);
    const createCall = ghNoDraft.log().find((c) => c.startsWith('pr create'))!;
    expect(createCall).not.toContain('--draft');
  });

  it('pushes ONLY with --push (verified against a real local remote)', async () => {
    const root = tempRepo();
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    // A real bare remote so the actual `git push` path is exercised (git is NOT stubbed).
    const remoteDir = mkdtempSync(join(tmpdir(), 'al-gh-remote-'));
    stubDirs.push(remoteDir);
    execFileSync('git', ['init', '--bare', '-q', remoteDir]);
    git(root, ['remote', 'add', 'origin', remoteDir]);

    // Without --push: remote stays empty.
    const ghNoPush = ghStub();
    process.env['PATH'] = `${ghNoPush.dir}:${savedPath}`;
    await createPullRequest({ root, branch, remote: 'origin', draft: true, push: false }, snapshot, pm);
    const refsBefore = execFileSync('git', ['ls-remote', '--heads', remoteDir], { encoding: 'utf8' }).trim();
    expect(refsBefore).toBe('');

    // With --push: the branch lands on the remote.
    const ghPush = ghStub();
    process.env['PATH'] = `${ghPush.dir}:${savedPath}`;
    await createPullRequest({ root, branch, remote: 'origin', draft: true, push: true }, snapshot, pm);
    const refsAfter = execFileSync('git', ['ls-remote', '--heads', remoteDir], { encoding: 'utf8' }).trim();
    expect(refsAfter).toContain(`refs/heads/${branch}`);
  });
});

describe('importIssue (hermetic gh stub)', () => {
  it('imports an issue read-only and parses title/body/comments', async () => {
    const root = tempRepo();
    const gh = ghStub();
    process.env['PATH'] = `${gh.dir}:${savedPath}`;
    const issue = await importIssue(root, 42, pm);
    expect(issue.title).toBe('Add CSV export');
    expect(issue.body).toContain('write encoder');
    expect(issue.body).toContain('add tests please'); // comment merged
    expect(issueToText(issue)).toContain('Add CSV export');
    const calls = gh.log();
    expect(calls.some((c) => c.includes('issue view 42'))).toBe(true);
    expect(calls.every((c) => c.split(' :: ')[0] !== undefined && !c.split(' :: ')[0]!.includes('merge'))).toBe(true); // read-only verb
  });
});

describe('no auto-merge / auto-deploy path exists', () => {
  it('never invokes a merge/deploy verb across the full PR + issue surface', async () => {
    const root = tempRepo();
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const remoteDir = mkdtempSync(join(tmpdir(), 'al-gh-remote2-'));
    stubDirs.push(remoteDir);
    execFileSync('git', ['init', '--bare', '-q', remoteDir]);
    git(root, ['remote', 'add', 'origin', remoteDir]);
    const gh = ghStub();
    process.env['PATH'] = `${gh.dir}:${savedPath}`;

    await createPullRequest({ root, branch, remote: 'origin', draft: true, push: true }, snapshot, pm);
    await importIssue(root, 1, pm);

    const verbs = gh.log().map((c) => c.split(' :: ')[0]!.trim());
    // Only the safe verbs ever appear (the PR body's "auto-merge"/"deploy" prose
    // lives after the ' :: ' delimiter and is intentionally excluded here).
    for (const v of verbs) {
      expect(/^(pr list|pr create|issue view)$/.test(v), `unexpected gh verb: ${v}`).toBe(true);
    }
    expect(verbs.some((v) => v.includes('merge'))).toBe(false);
    expect(verbs.some((v) => v.includes('deploy'))).toBe(false);
  });

  it('the github module source contains no `gh pr merge` / deploy construction', () => {
    const prSrc = readFileSync(fileURLToPath(new URL('../../src/github/pr.ts', import.meta.url)), 'utf8');
    const issueSrc = readFileSync(fileURLToPath(new URL('../../src/github/issue.ts', import.meta.url)), 'utf8');
    // No `gh pr merge` argv construction (won't match the prose "auto-merge"/"merging").
    expect(/pr['"\s,]+merge/.test(prSrc)).toBe(false);
    expect(/['"]merge['"]/.test(prSrc)).toBe(false);
    expect(/['"]merge['"]/.test(issueSrc)).toBe(false);
    // No deploy command construction anywhere in the module.
    expect(/['"]deploy['"]/.test(prSrc)).toBe(false);
    expect(/['"]deploy['"]/.test(issueSrc)).toBe(false);
  });
});

// ---- OPT-IN live check against a throwaway repo (read-only by default) ----
const liveRepo = process.env['AGENT_LOOP_GH_LIVE'] === '1' ? process.env['AGENT_LOOP_GH_LIVE_REPO'] : undefined;
describe.skipIf(!liveRepo)('live GitHub [opt-in: AGENT_LOOP_GH_LIVE=1]', () => {
  it('confirms gh auth + repo access without mutating anything', async () => {
    const auth = await pm.run(['gh', 'auth', 'status'], { cwd: process.cwd(), timeoutMs: 30_000 }).catch((e: unknown) => ({ ok: false, stderr: (e as Error).message } as { ok: boolean; stderr: string }));
    expect(auth.ok, `gh not authenticated: ${'stderr' in auth ? auth.stderr : ''}`).toBe(true);
    const view = await pm.run(['gh', 'repo', 'view', liveRepo!, '--json', 'name'], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(view.ok).toBe(true);
    expect(view.stdout).toContain('name');
  }, 60_000);
});

/**
 * Thin, safe wrapper around the `gh` CLI. Every GitHub call funnels through here.
 *
 * Safety properties (enforced by construction):
 *  - There is NO merge, NO deploy, and NO issue-close method. The class simply
 *    does not expose those verbs, so no caller can invoke them.
 *  - Every WRITE (label add/remove, comment, label create, project mutation) is
 *    gated by `dryRun`: in dry-run the gh process is never spawned, and the
 *    intended action is reported via `onWrite`. In apply mode the write runs AND
 *    is still reported, so there is always an audit line.
 *  - Reads (issue list/view, project lookup) always run; they mutate nothing.
 */
import { ProcessManager } from '../process/manager.js';
import { GitError } from '../domain/errors.js';

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url?: string;
  state?: string;
}

export interface GhPr {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName?: string;
  files: string[];
  commits: number;
}

export interface GhWrite {
  action: string;
  detail: string;
  dryRun: boolean;
}

export interface GhClientOptions {
  dryRun: boolean;
  pm?: ProcessManager;
  /** Called for every write (in dry-run AND apply) — the audit hook. */
  onWrite?: (write: GhWrite) => void;
  timeoutMs?: number;
}

export class GhClient {
  private readonly pm: ProcessManager;
  private readonly dryRun: boolean;
  private readonly onWrite: ((write: GhWrite) => void) | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly root: string,
    opts: GhClientOptions,
  ) {
    this.pm = opts.pm ?? new ProcessManager();
    this.dryRun = opts.dryRun;
    this.onWrite = opts.onWrite;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  // --- reads -----------------------------------------------------------------

  async listIssues(
    repo: string,
    opts: { labels?: string[]; state?: 'open' | 'closed' | 'all'; limit?: number } = {},
  ): Promise<GhIssue[]> {
    const args = [
      'issue',
      'list',
      '--repo',
      repo,
      '--json',
      'number,title,body,labels,url,state',
      '--state',
      opts.state ?? 'open',
      '--limit',
      String(opts.limit ?? 50),
    ];
    for (const l of opts.labels ?? []) args.push('--label', l);
    const res = await this.read(args, `list issues for ${repo}`);
    return parseIssues(res);
  }

  async viewIssue(repo: string, number: number): Promise<GhIssue> {
    const res = await this.read(
      ['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,body,labels,url,state'],
      `view issue #${number}`,
    );
    const parsed = parseIssues(`[${res}]`);
    const issue = parsed[0];
    if (!issue) throw new GitError(`could not parse issue #${number} from gh output`);
    return issue;
  }

  /** Read PR metadata (read-only; mutates nothing). There is deliberately NO merge,
   * NO close, and NO ready-for-review verb on this client. */
  async viewPr(repo: string, number: number): Promise<GhPr> {
    const res = await this.read(
      ['pr', 'view', String(number), '--repo', repo, '--json', 'number,url,state,isDraft,headRefName,baseRefName,files,commits'],
      `view PR #${number}`,
    );
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(res) as Record<string, unknown>;
    } catch {
      throw new GitError(`could not parse PR #${number} from gh output`);
    }
    const files = Array.isArray(o['files'])
      ? (o['files'] as unknown[]).map((f) => (f && typeof f === 'object' ? ((f as Record<string, unknown>)['path'] as string) : undefined)).filter((x): x is string => !!x)
      : [];
    const commits = Array.isArray(o['commits']) ? (o['commits'] as unknown[]).length : 0;
    return {
      number: typeof o['number'] === 'number' ? (o['number'] as number) : number,
      url: typeof o['url'] === 'string' ? (o['url'] as string) : '',
      state: typeof o['state'] === 'string' ? (o['state'] as string) : '',
      isDraft: o['isDraft'] === true,
      headRefName: typeof o['headRefName'] === 'string' ? (o['headRefName'] as string) : '',
      ...(typeof o['baseRefName'] === 'string' ? { baseRefName: o['baseRefName'] as string } : {}),
      files,
      commits,
    };
  }

  /** Post a comment on a PR. A WRITE — gated by `dryRun` like every other write
   * (in dry-run the gh process is never spawned; intent is reported via onWrite). */
  async commentPr(repo: string, number: number, body: string): Promise<void> {
    await this.write(
      ['pr', 'comment', String(number), '--repo', repo, '--body', body],
      'pr-comment',
      `PR #${number}: ${firstLine(body)}`,
    );
  }

  /** Run `gh api graphql`; returns parsed JSON (or throws GitError). Read-only by
   * convention here — used for project lookups; mutations go through `graphqlWrite`. */
  async graphql(query: string, fields: Record<string, string | number> = {}): Promise<unknown> {
    const res = await this.read(['api', 'graphql', ...graphqlVars(query, fields)], 'graphql query');
    try {
      return JSON.parse(res);
    } catch (err) {
      throw new GitError(`gh graphql returned non-JSON: ${(err as Error).message}`);
    }
  }

  // --- writes (gated by dryRun) ---------------------------------------------

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.write(
      ['issue', 'edit', String(number), '--repo', repo, '--add-label', labels.join(',')],
      'add-labels',
      `#${number} += [${labels.join(', ')}]`,
    );
  }

  async removeLabels(repo: string, number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    // Best-effort: removing a label that isn't actually on the issue (state drift)
    // must not crash a triage/watch pass.
    await this.write(
      ['issue', 'edit', String(number), '--repo', repo, '--remove-label', labels.join(',')],
      'remove-labels',
      `#${number} -= [${labels.join(', ')}]`,
      { bestEffort: true },
    );
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.write(
      ['issue', 'comment', String(number), '--repo', repo, '--body', body],
      'comment',
      `#${number}: ${firstLine(body)}`,
    );
  }

  /** Best-effort label creation; never throws (a missing label just can't be applied). */
  async ensureLabel(repo: string, name: string, color = 'ededed', description = ''): Promise<void> {
    await this.write(
      ['label', 'create', name, '--repo', repo, '--color', color, '--description', description, '--force'],
      'ensure-label',
      `${name}`,
      { bestEffort: true },
    );
  }

  /** Run a GraphQL MUTATION (write). Gated by dryRun like every other write. */
  async graphqlWrite(query: string, fields: Record<string, string | number>, detail: string): Promise<unknown> {
    const args = ['api', 'graphql', ...graphqlVars(query, fields)];
    const res = await this.write(args, 'project-mutation', detail, { bestEffort: true, capture: true });
    if (res === undefined) return undefined; // dry-run
    try {
      return JSON.parse(res);
    } catch {
      return undefined;
    }
  }

  // --- internals -------------------------------------------------------------

  private async read(args: string[], what: string): Promise<string> {
    const res = await this.pm.run(['gh', ...args], { cwd: this.root, timeoutMs: this.timeoutMs });
    if (!res.ok) {
      throw new GitError(`gh failed to ${what} (exit ${res.exitCode}). Is gh installed and authenticated?`, {
        details: { stderr: res.stderr.slice(0, 500) },
      });
    }
    return res.stdout.trim();
  }

  private async write(
    args: string[],
    action: string,
    detail: string,
    opts: { bestEffort?: boolean; capture?: boolean } = {},
  ): Promise<string | undefined> {
    this.onWrite?.({ action, detail, dryRun: this.dryRun });
    if (this.dryRun) return undefined;
    const res = await this.pm.run(['gh', ...args], { cwd: this.root, timeoutMs: this.timeoutMs });
    if (!res.ok) {
      if (opts.bestEffort) return undefined;
      throw new GitError(`gh ${action} failed (exit ${res.exitCode}).`, { details: { stderr: res.stderr.slice(0, 500) } });
    }
    return opts.capture ? res.stdout.trim() : res.stdout;
  }
}

/** Build `gh api graphql` argv: string vars use `-f`, numbers use `-F` (typed). */
function graphqlVars(query: string, fields: Record<string, string | number>): string[] {
  const args = ['-f', `query=${query}`];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'number') args.push('-F', `${k}=${v}`);
    else args.push('-f', `${k}=${v}`);
  }
  return args;
}

function parseIssues(json: string): GhIssue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    const labels = Array.isArray(o['labels'])
      ? (o['labels'] as unknown[]).map((l) => (typeof l === 'string' ? l : ((l as Record<string, unknown>)['name'] as string))).filter(Boolean)
      : [];
    return {
      number: typeof o['number'] === 'number' ? (o['number'] as number) : 0,
      title: typeof o['title'] === 'string' ? (o['title'] as string) : '',
      body: typeof o['body'] === 'string' ? (o['body'] as string) : '',
      labels,
      ...(typeof o['url'] === 'string' ? { url: o['url'] as string } : {}),
      ...(typeof o['state'] === 'string' ? { state: o['state'] as string } : {}),
    } satisfies GhIssue;
  });
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').slice(0, 80);
}

/**
 * GitHub issue import via the `gh` CLI. Optional: the core loop never requires
 * GitHub credentials. Returns the issue as plain text the intake layer can
 * normalize like any other input.
 */
import { ProcessManager } from '../process/manager.js';
import { GitError } from '../domain/errors.js';

export interface ImportedIssue {
  number: number;
  title: string;
  body: string;
}

export async function importIssue(root: string, issueNumber: number, pm = new ProcessManager()): Promise<ImportedIssue> {
  const res = await pm.run(['gh', 'issue', 'view', String(issueNumber), '--json', 'title,body,comments'], {
    cwd: root,
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    throw new GitError(`failed to import issue #${issueNumber} via gh (exit ${res.exitCode}). Is gh installed and authenticated?`, {
      details: { stderr: res.stderr.slice(0, 500) },
    });
  }
  const parsed = JSON.parse(res.stdout) as {
    title?: string;
    body?: string;
    comments?: Array<{ body?: string; author?: { login?: string } }>;
  };
  const comments = (parsed.comments ?? [])
    .map((c) => `> comment by ${c.author?.login ?? 'user'}:\n${c.body ?? ''}`)
    .join('\n\n');
  const body = [parsed.body ?? '', comments].filter(Boolean).join('\n\n');
  return { number: issueNumber, title: parsed.title ?? `Issue #${issueNumber}`, body };
}

/** Build the text blob intake normalizes (issue kind). */
export function issueToText(issue: ImportedIssue): string {
  return `${issue.title}\n\n${issue.body}`;
}

/**
 * Resolve a RawInput for intake from CLI flags: --idea, --prd, --spec, --readme,
 * --issue, or --stdin.
 */
import { readFileSync } from 'node:fs';
import type { RawInput } from '../intake/normalize.js';
import { importIssue, issueToText } from '../github/issue.js';
import { IntakeError } from '../domain/errors.js';
import { flagStr, flagBool, type ParsedArgs } from './args.js';

/** Read an input file, turning fs errors into a clear, typed intake error. */
function readInputFile(path: string, flag: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'is a directory' : (err as Error).message;
    throw new IntakeError(`cannot read --${flag} file '${path}': ${why}`);
  }
}

export async function resolveInput(args: ParsedArgs, root: string): Promise<RawInput | undefined> {
  const idea = flagStr(args, 'idea');
  if (idea) return { kind: 'idea', text: idea };

  const prd = flagStr(args, 'prd');
  if (prd) {
    const text = readInputFile(prd, 'prd');
    return { kind: prd.endsWith('.json') ? 'prd-json' : 'prd-md', text, ref: prd };
  }

  const spec = flagStr(args, 'spec');
  if (spec) return { kind: 'spec', text: readInputFile(spec, 'spec'), ref: spec };

  const readme = flagStr(args, 'readme');
  if (readme) return { kind: 'readme', text: readInputFile(readme, 'readme'), ref: readme };

  const issue = flagStr(args, 'issue');
  if (issue) {
    const n = Number(issue);
    if (!Number.isInteger(n) || n <= 0) {
      throw new IntakeError(`--issue must be a positive integer issue number, got '${issue}'`);
    }
    const imported = await importIssue(root, n);
    return { kind: 'issue', text: issueToText(imported), ref: `#${issue}` };
  }

  if (flagBool(args, 'stdin')) {
    const text = await readStdin();
    return { kind: 'stdin', text };
  }
  return undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

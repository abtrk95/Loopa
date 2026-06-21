/**
 * Resolve a RawInput for intake from CLI flags: --idea, --prd, --spec, --readme,
 * --issue, or --stdin.
 */
import { readFileSync } from 'node:fs';
import type { RawInput } from '../intake/normalize.js';
import { importIssue, issueToText } from '../github/issue.js';
import { flagStr, flagBool, type ParsedArgs } from './args.js';

export async function resolveInput(args: ParsedArgs, root: string): Promise<RawInput | undefined> {
  const idea = flagStr(args, 'idea');
  if (idea) return { kind: 'idea', text: idea };

  const prd = flagStr(args, 'prd');
  if (prd) {
    const text = readFileSync(prd, 'utf8');
    return { kind: prd.endsWith('.json') ? 'prd-json' : 'prd-md', text, ref: prd };
  }

  const spec = flagStr(args, 'spec');
  if (spec) return { kind: 'spec', text: readFileSync(spec, 'utf8'), ref: spec };

  const readme = flagStr(args, 'readme');
  if (readme) return { kind: 'readme', text: readFileSync(readme, 'utf8'), ref: readme };

  const issue = flagStr(args, 'issue');
  if (issue) {
    const imported = await importIssue(root, Number(issue));
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

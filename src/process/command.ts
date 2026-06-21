/**
 * Command tokenization. A CommandSpec is either an argv array (used as-is) or a
 * human-friendly string that we split into argv with a quote-aware tokenizer.
 * Crucially, the result is ALWAYS executed without a shell (spawn shell:false),
 * so neither form is exposed to shell injection.
 */
import { ProcessError } from '../domain/errors.js';
import type { CommandSpec } from '../domain/schemas.js';

export interface Argv {
  file: string;
  args: string[];
  /** A display string (never re-parsed). */
  display: string;
}

/** Split a command line into tokens, honoring single and double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasToken = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) {
    throw new ProcessError(`unbalanced quote in command: ${line}`);
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

export function resolveCommand(spec: CommandSpec): Argv {
  if (Array.isArray(spec)) {
    if (spec.length === 0) throw new ProcessError('empty argv command');
    const [file, ...args] = spec;
    return { file: file!, args, display: spec.join(' ') };
  }
  const tokens = tokenize(spec);
  if (tokens.length === 0) throw new ProcessError(`empty command: ${spec}`);
  const [file, ...args] = tokens;
  return { file: file!, args, display: spec };
}

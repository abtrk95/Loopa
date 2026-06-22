/**
 * Readline-backed {@link Prompter} for the interactive interview. Kept out of the
 * core intake engine so that engine has no stdin dependency and stays unit-testable.
 */
import { createInterface } from 'node:readline';
import type { Prompter } from '../intake/interview.js';

export class ReadlinePrompter implements Prompter {
  async ask(question: string, opts?: { default?: string }): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = opts?.default ? ` [${opts.default}]` : '';
    try {
      const answer = await new Promise<string>((resolve) => rl.question(`${question}${suffix}\n> `, resolve));
      const trimmed = answer.trim();
      return trimmed === '' && opts?.default !== undefined ? opts.default : trimmed;
    } finally {
      rl.close();
    }
  }
}

/** True when both ends of stdio are a TTY (safe to prompt interactively). */
export function canPromptInteractively(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

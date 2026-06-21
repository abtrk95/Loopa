/**
 * Environment hygiene for child processes.
 *
 * Two responsibilities:
 *  1. Strip variables that could let an agent poison git/worktree state.
 *  2. Discover secret-bearing values so the Redactor can mask them in any output
 *     we persist or display. Note: we do NOT strip provider credentials from the
 *     CHILD env (the agent CLI may legitimately need them); we only ensure their
 *     values never reach logs.
 */

/** Variables that must never be inherited by spawned processes. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
]);

/** Keys whose values are treated as secrets for redaction purposes. */
const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH)/i;

export interface FilteredEnv {
  /** Sanitized environment safe to pass to a child process. */
  env: Record<string, string>;
  /** Literal secret values for the Redactor. */
  secretValues: string[];
}

/**
 * Produce a sanitized child environment and the list of secret values to redact.
 * `base` defaults to the current process environment.
 */
export function filterEnv(base: NodeJS.ProcessEnv = process.env): FilteredEnv {
  const env: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (DANGEROUS_KEYS.has(key)) continue;
    env[key] = value;
    if (SECRET_KEY_PATTERN.test(key) && value.length >= 6) {
      secretValues.push(value);
    }
  }
  return { env, secretValues };
}

/** Collect secret values from an env without otherwise filtering it. */
export function collectSecretValues(base: NodeJS.ProcessEnv = process.env): string[] {
  return filterEnv(base).secretValues;
}

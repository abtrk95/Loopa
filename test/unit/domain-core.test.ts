import { describe, it, expect } from 'vitest';
import { assertRunTransition, assertSliceTransition, canRunTransition, canSliceTransition, isTerminalRunState } from '../../src/domain/states.js';
import { InvalidStateTransitionError } from '../../src/domain/errors.js';
import { Redactor, redact } from '../../src/security/redact.js';
import { filterEnv } from '../../src/security/env.js';
import { tokenize, resolveCommand } from '../../src/process/command.js';
import { ReviewVerdictSchema } from '../../src/domain/schemas.js';
import { parseStructuredResult } from '../../src/providers/types.js';
import { maxAttempts, canRetry, backoffDelayMs } from '../../src/orchestrator/retry.js';

describe('state machines', () => {
  it('allows valid run transitions and rejects invalid', () => {
    expect(canRunTransition('PLAN_READY', 'RUNNING')).toBe(true);
    expect(canRunTransition('RUNNING', 'COMPLETED')).toBe(false); // must go through FINAL_VERIFYING
    expect(() => assertRunTransition('COMPLETED', 'RUNNING')).toThrow(InvalidStateTransitionError);
    expect(isTerminalRunState('COMPLETED')).toBe(true);
  });
  it('allows valid slice transitions and rejects invalid', () => {
    expect(canSliceTransition('VERIFYING', 'COMMITTING')).toBe(true);
    expect(canSliceTransition('COMPLETED', 'EXECUTING')).toBe(false);
    expect(() => assertSliceTransition('PENDING', 'COMPLETED')).toThrow();
  });
});

describe('secret redaction', () => {
  it('masks known credential shapes', () => {
    expect(redact('token sk-ant-abcdefghijklmnopqrstuvwxyz123')).toContain('***REDACTED***');
    expect(redact('ghp_0123456789abcdefghijABCDEFGHIJ')).toContain('***REDACTED***');
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
  it('masks literal env secret values', () => {
    const r = new Redactor(['supersecretvalue123']);
    expect(r.redact('the key is supersecretvalue123 ok')).toBe('the key is ***REDACTED*** ok');
  });
  it('filterEnv strips git-poisoning vars and collects secret values', () => {
    const { env, secretValues } = filterEnv({ GIT_DIR: '/x', PATH: '/usr/bin', MY_API_KEY: 'abcdef123456' });
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(secretValues).toContain('abcdef123456');
  });
});

describe('command tokenizer', () => {
  it('splits respecting quotes', () => {
    expect(tokenize('npm run test')).toEqual(['npm', 'run', 'test']);
    expect(tokenize('node -e "process.exit(0)"')).toEqual(['node', '-e', 'process.exit(0)']);
    expect(tokenize("echo 'a b' c")).toEqual(['echo', 'a b', 'c']);
  });
  it('resolves argv arrays and strings to the same shape', () => {
    expect(resolveCommand(['git', 'status'])).toMatchObject({ file: 'git', args: ['status'] });
    expect(resolveCommand('git status')).toMatchObject({ file: 'git', args: ['status'] });
  });
  it('throws on unbalanced quotes', () => {
    expect(() => tokenize('echo "unterminated')).toThrow();
  });
});

describe('reviewer schema + structured result', () => {
  it('accepts a valid verdict and rejects malformed', () => {
    expect(ReviewVerdictSchema.safeParse({ verdict: 'pass', findings: [] }).success).toBe(true);
    expect(ReviewVerdictSchema.safeParse({ verdict: 'nope' }).success).toBe(false);
  });
  it('parses the last result marker line', () => {
    const out = 'noise\n__AGENT_LOOP_RESULT__ {"summary":"did it"}\nmore';
    expect(parseStructuredResult(out)).toEqual({ summary: 'did it' });
    expect(parseStructuredResult('no marker')).toBeUndefined();
  });
});

describe('retry policy', () => {
  it('caps attempts and computes deterministic backoff', () => {
    expect(maxAttempts(2)).toBe(3);
    expect(canRetry(1, 2)).toBe(true);
    expect(canRetry(3, 2)).toBe(false);
    expect(backoffDelayMs(1, 0, 0)).toBe(0);
    expect(backoffDelayMs(2, 100, 0)).toBe(200);
    expect(backoffDelayMs(2, 100, 0)).toBe(backoffDelayMs(2, 100, 0)); // deterministic
  });
});

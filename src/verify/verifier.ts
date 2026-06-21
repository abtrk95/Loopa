/**
 * Deterministic verifier — the authority on whether a slice's work is acceptable.
 * It is completely independent of the model: it reads only the real git diff, the
 * changed-path set, the slice/plan/config, and the exit codes of required checks.
 * A model reviewer may add semantic findings later, but it can NEVER override a
 * failed deterministic check here.
 *
 * Verdicts:
 *   pass  — all safety scans clean and all required checks passed → eligible to commit
 *   fail  — a recoverable problem (out-of-scope edit, failing test, oversized diff,
 *           test weakening) → the orchestrator may retry within the budget
 *   block — a hard violation (secret, write under .git, path traversal, symlink
 *           escape, forbidden path) → stop; not auto-retryable
 */
import { join } from 'node:path';
import { atomicWrite } from '../util/fs.js';
import type { GitRepo } from '../git/repo.js';
import type { ProcessManager } from '../process/manager.js';
import type { Redactor } from '../security/redact.js';
import type { Slice, Plan, CheckSpec, Expect } from '../domain/schemas.js';
import type { Config } from '../config/config.js';
import { evaluateScope, structuralScan } from '../git/scope.js';
import { resolveCommand } from '../process/command.js';
import { detectSecretsInDiff, detectTestWeakening, lockfilesIn } from './checks.js';

export type Verdict = 'pass' | 'fail' | 'block';

export interface CheckResult {
  id: string;
  command: string;
  kind:
    | 'empty-diff'
    | 'scope'
    | 'structural'
    | 'secrets'
    | 'diff-size'
    | 'test-weakening'
    | 'lockfile'
    | 'command';
  ok: boolean;
  exitCode?: number | null;
  durationMs: number;
  summary: string;
}

export interface Finding {
  severity: 'block' | 'fail' | 'flag';
  detail: string;
}

export interface VerificationResult {
  verdict: Verdict;
  reason?: string;
  checks: CheckResult[];
  findings: Finding[];
  changedFiles: string[];
  addedLines: number;
}

export interface VerifyInput {
  repo: GitRepo;
  slice: Slice;
  plan: Plan;
  config: Config;
  pm: ProcessManager;
  redactor: Redactor;
  checksDir: string;
  signal?: AbortSignal | undefined;
  isFinal?: boolean;
  onCheckStart?: (c: { id: string; command: string }) => void;
  onCheckFinish?: (c: CheckResult) => void;
  onCheckOutput?: (c: { id: string; summary: string }) => void;
}

const INTERNAL_PREFIXES = ['.agent-loop/'];

export async function verify(input: VerifyInput): Promise<VerificationResult> {
  const { repo, slice, plan, config } = input;
  const checks: CheckResult[] = [];
  const findings: Finding[] = [];
  let verdict: Verdict = 'pass';
  let reason: string | undefined;

  const record = (c: CheckResult): void => {
    checks.push(c);
    input.onCheckFinish?.(c);
  };
  const downgrade = (to: Verdict, why: string): void => {
    if (to === 'block') {
      verdict = 'block';
      reason = why;
    } else if (to === 'fail' && verdict === 'pass') {
      verdict = 'fail';
      reason = why;
    }
  };

  const changedFiles = (await repo.changedPaths()).filter(
    (p) => !INTERNAL_PREFIXES.some((pre) => p.startsWith(pre)),
  );
  const addedLines = await repo.addedLines();

  if (changedFiles.length === 0 && !input.isFinal) {
    record({ id: 'changes', command: 'git status', kind: 'empty-diff', ok: false, durationMs: 0, summary: 'no files changed' });
    return { verdict: 'fail', reason: 'agent produced no file changes', checks, findings, changedFiles, addedLines };
  }

  if (!input.isFinal) {
    // --- scope policy ---
    const scope = evaluateScope({
      changedPaths: changedFiles,
      allowedPaths: slice.allowedPaths,
      forbiddenPaths: slice.forbiddenPaths,
      globalForbidden: plan.riskPolicy.globalForbiddenPaths,
    });
    record({
      id: 'scope',
      command: 'path-policy',
      kind: 'scope',
      ok: scope.ok,
      durationMs: 0,
      summary: scope.ok
        ? 'all changes within allowed scope'
        : `forbidden=[${scope.forbidden.join(', ')}] outOfScope=[${scope.outOfScope.join(', ')}]`,
    });
    if (scope.forbidden.length > 0) {
      findings.push({ severity: 'block', detail: `forbidden paths modified: ${scope.forbidden.join(', ')}` });
      downgrade('block', 'modified forbidden paths');
    }
    if (scope.outOfScope.length > 0) {
      findings.push({ severity: 'fail', detail: `out-of-scope paths: ${scope.outOfScope.join(', ')}` });
      downgrade('fail', 'changed files outside allowedPaths');
    }

    // --- structural safety ---
    const structural = structuralScan(repo.dir, changedFiles, { flagBinary: config.verification.flagBinary });
    if (structural.length > 0) {
      let structOk = true;
      for (const f of structural) {
        if (f.kind === 'git-internal' || f.kind === 'traversal' || f.kind === 'symlink-escape') {
          findings.push({ severity: 'block', detail: `${f.kind}: ${f.path}` });
          downgrade('block', `${f.kind} detected`);
          structOk = false;
        } else if (f.kind === 'submodule') {
          findings.push({ severity: 'fail', detail: `submodule change: ${f.path}` });
          downgrade('fail', 'submodule change');
          structOk = false;
        } else {
          findings.push({ severity: 'flag', detail: `${f.kind}: ${f.path}${f.detail ? ' ' + f.detail : ''}` });
        }
      }
      record({ id: 'structural', command: 'structural-scan', kind: 'structural', ok: structOk, durationMs: 0, summary: `${structural.length} finding(s)` });
    } else {
      record({ id: 'structural', command: 'structural-scan', kind: 'structural', ok: true, durationMs: 0, summary: 'clean' });
    }

    // --- secrets ---
    if (config.verification.detectSecrets) {
      const diff = await repo.diffWithUntracked();
      const hits = detectSecretsInDiff(diff);
      record({ id: 'secrets', command: 'secret-scan', kind: 'secrets', ok: hits.length === 0, durationMs: 0, summary: hits.length === 0 ? 'no secrets in diff' : `${hits.length} potential secret(s)` });
      if (hits.length > 0) {
        for (const h of hits) findings.push({ severity: 'block', detail: `secret: ${h.snippet}` });
        downgrade('block', 'potential secret in diff');
      }
    }

    // --- diff size ---
    const maxLines = Math.min(plan.riskPolicy.maxDiffLines, config.verification.maxDiffLines);
    const sizeOk = addedLines <= maxLines;
    record({ id: 'diff-size', command: 'diff-size', kind: 'diff-size', ok: sizeOk, durationMs: 0, summary: `${addedLines} added line(s), limit ${maxLines}` });
    if (!sizeOk) {
      findings.push({ severity: 'fail', detail: `diff too large: ${addedLines} > ${maxLines}` });
      downgrade('fail', 'diff exceeds size limit');
    }

    // --- test weakening ---
    if (config.verification.detectTestWeakening) {
      const diff = await repo.diffWithUntracked();
      const weak = detectTestWeakening(diff);
      record({ id: 'test-weakening', command: 'test-weakening-scan', kind: 'test-weakening', ok: weak.length === 0, durationMs: 0, summary: weak.length === 0 ? 'no test weakening' : weak.map((w) => w.kind).join(', ') });
      if (weak.length > 0) {
        for (const w of weak) findings.push({ severity: 'fail', detail: `test weakening (${w.kind}): ${w.detail}` });
        downgrade('fail', 'test weakening detected');
      }
    }

    // --- lockfile policy ---
    const locks = lockfilesIn(changedFiles);
    if (locks.length > 0) {
      const allowed = plan.riskPolicy.allowLockfileChanges;
      record({ id: 'lockfile', command: 'lockfile-policy', kind: 'lockfile', ok: allowed, durationMs: 0, summary: `${locks.join(', ')} ${allowed ? '(allowed)' : '(not allowed)'}` });
      if (!allowed) {
        findings.push({ severity: 'fail', detail: `lockfile change not allowed: ${locks.join(', ')}` });
        downgrade('fail', 'lockfile change not allowed');
      } else {
        findings.push({ severity: 'flag', detail: `lockfile changed: ${locks.join(', ')}` });
      }
    }

    // Short-circuit before expensive command checks if safety already failed.
    if (verdict !== 'pass') {
      return { verdict, ...(reason ? { reason } : {}), checks, findings, changedFiles, addedLines };
    }
  }

  // --- required command checks (the expensive stage) ---
  const specs = resolveChecks(input);
  for (const spec of specs) {
    if (input.signal?.aborted) {
      downgrade('fail', 'verification cancelled');
      break;
    }
    const argv = resolveCommand(spec.command);
    if (config.verification.deniedCommands.includes(argv.file)) {
      findings.push({ severity: 'block', detail: `denied command: ${argv.file}` });
      record({ id: spec.id, command: argv.display, kind: 'command', ok: false, durationMs: 0, summary: 'command denied by policy' });
      downgrade('block', `command '${argv.file}' is denied by policy`);
      break;
    }
    if (config.verification.allowedCommands.length > 0 && !config.verification.allowedCommands.includes(argv.file)) {
      record({ id: spec.id, command: argv.display, kind: 'command', ok: true, durationMs: 0, summary: 'skipped (not in allowedCommands)' });
      findings.push({ severity: 'flag', detail: `check '${spec.id}' skipped: ${argv.file} not in allowedCommands` });
      continue;
    }
    input.onCheckStart?.({ id: spec.id, command: argv.display });
    const res = await input.pm.run(spec.command, {
      cwd: repo.dir,
      timeoutMs: spec.timeoutMs ?? config.execution.checkTimeoutMs,
      redactor: input.redactor,
      maxOutputBytes: config.execution.maxOutputBytes,
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch((err: unknown) => ({
      ok: false,
      exitCode: null as number | null,
      stdout: '',
      stderr: (err as Error).message,
      durationMs: 0,
      command: argv.display,
    }));
    const ok = evaluateExpect(spec.expect ?? 'exit_zero', res.exitCode, res.stdout, spec.contains);
    const logPath = join(input.checksDir, `${input.slice.id}__${spec.id}.log`);
    atomicWrite(logPath, `$ ${argv.display}\n\n[stdout]\n${res.stdout}\n[stderr]\n${res.stderr}\n`);
    const summary = ok ? `passed (exit ${res.exitCode})` : `failed (exit ${res.exitCode})`;
    input.onCheckOutput?.({ id: spec.id, summary });
    record({ id: spec.id, command: argv.display, kind: 'command', ok, exitCode: res.exitCode, durationMs: res.durationMs, summary });
    if (!ok) {
      findings.push({ severity: 'fail', detail: `check '${spec.id}' failed: ${argv.display}` });
      downgrade('fail', `required check '${spec.id}' failed`);
    }
  }

  return { verdict, ...(reason ? { reason } : {}), checks, findings, changedFiles, addedLines };
}

interface ResolvedCheck {
  id: string;
  command: CheckSpec['command'];
  expect?: Expect;
  contains?: string;
  timeoutMs?: number;
}

function resolveChecks(input: VerifyInput): ResolvedCheck[] {
  const globalById = new Map(input.plan.verification.map((c) => [c.id, c]));
  if (input.isFinal) {
    return input.plan.verification.map((c) => toResolved(c));
  }
  const out: ResolvedCheck[] = [];
  for (const rc of input.slice.requiredChecks) {
    const global = globalById.get(rc);
    if (global) out.push(toResolved(global));
    else out.push({ id: rc.replace(/\s+/g, '-').slice(0, 40), command: rc });
  }
  return out;
}

function toResolved(c: CheckSpec): ResolvedCheck {
  return {
    id: c.id,
    command: c.command,
    ...(c.expect ? { expect: c.expect } : {}),
    ...(c.contains ? { contains: c.contains } : {}),
    ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
  };
}

function evaluateExpect(expect: Expect, exitCode: number | null, stdout: string, contains?: string): boolean {
  switch (expect) {
    case 'exit_zero':
      return exitCode === 0;
    case 'exit_nonzero':
      return exitCode !== 0;
    case 'stdout_contains':
      return contains !== undefined && stdout.includes(contains);
    default:
      return false;
  }
}

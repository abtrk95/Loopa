/**
 * Interview engine unit tests. Pure logic, no stdin: a scripted prompter drives
 * the interactive path; auto mode derives conservative assumptions. Proves the
 * interview improves planning while only ever STRENGTHENING safety.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
  conductInterview,
  applyInterview,
  applyOrchestration,
  clarificationPrompts,
  selectQuestions,
  selectOrchestrationQuestions,
  type InterviewAnswers,
  type InterviewContext,
  type Prompter,
} from '../../src/intake/interview.js';
import {
  buildRecommendations,
  computeSignals,
  type ProviderInfo,
  type RecommendInputs,
  type Recommendation,
} from '../../src/intake/recommend.js';
import { defaultConfig } from '../../src/config/config.js';
import { normalizeInput } from '../../src/intake/normalize.js';
import { buildPlan } from '../../src/planner/plan.js';
import { assertValidPlan } from '../../src/planner/validate.js';
import { PlanSchema } from '../../src/domain/schemas.js';
import { IntakeError } from '../../src/domain/errors.js';

class ScriptedPrompter implements Prompter {
  private i = 0;
  constructor(private readonly answers: string[]) {}
  async ask(): Promise<string> {
    return this.answers[this.i++] ?? '';
  }
}

const root = tmpdir();

function baseFor(text: string, kind: 'idea' | 'prd-json' = 'idea') {
  return normalizeInput({ kind, text }, { root, auto: true });
}

describe('interview — question selection by mode', () => {
  it('quick asks only the few critical-missing questions', () => {
    const ctx: InterviewContext = { detectedChecks: [], auto: false, interactive: true };
    const keys = selectQuestions('quick', ctx).map((q) => q.key);
    expect(keys).toEqual(['goal', 'acceptanceCriteria', 'verificationCommands']);
  });

  it('standard asks more than quick; strict asks more than standard', () => {
    const ctx: InterviewContext = { detectedChecks: [], auto: false, interactive: true };
    const quick = selectQuestions('quick', ctx).length;
    const standard = selectQuestions('standard', ctx).length;
    const strict = selectQuestions('strict', ctx).length;
    expect(standard).toBeGreaterThan(quick);
    expect(strict).toBeGreaterThan(standard);
  });

  it('skips questions already answered by the input', () => {
    const ctx: InterviewContext = { base: baseFor('Build a billing dashboard'), detectedChecks: ['test'], auto: false, interactive: true };
    const keys = selectQuestions('quick', ctx).map((q) => q.key);
    // goal present (idea) + verification detected → only acceptanceCriteria remains in quick.
    expect(keys).toEqual(['acceptanceCriteria']);
  });
});

describe('interview — interactive (scripted prompter)', () => {
  it('captures quick answers from the user', async () => {
    const ctx: InterviewContext = { detectedChecks: [], auto: false, interactive: true };
    const prompter = new ScriptedPrompter(['Build a thing', 'works end to end, has tests', 'npm test']);
    const outcome = await conductInterview('quick', ctx, prompter);
    expect(outcome.answers.goal).toBe('Build a thing');
    expect(outcome.answers.acceptanceCriteria).toEqual(['works end to end', 'has tests']);
    expect(outcome.answers.verificationCommands).toEqual(['npm test']);
  });
});

describe('interview — non-interactive auto assumptions', () => {
  it('records conservative assumptions and flags low-confidence ones', async () => {
    const ctx: InterviewContext = { base: baseFor('Add a CSV export'), detectedChecks: ['test'], auto: true, interactive: false };
    const outcome = await conductInterview('standard', ctx);
    expect(outcome.assumptions.length).toBeGreaterThan(0);
    expect(outcome.assumptions.some((a) => a.confidence === 'low')).toBe(true);
    // a safe default exists for merge policy: never auto-merge.
    expect(outcome.answers.mergePolicy === undefined || /never auto-merge/i.test(outcome.answers.mergePolicy)).toBe(true);
  });

  it('does NOT prompt in auto mode even if a prompter is provided', async () => {
    const ctx: InterviewContext = { base: baseFor('Add a CSV export'), detectedChecks: ['test'], auto: true, interactive: true };
    let asked = 0;
    const prompter: Prompter = { ask: async () => ((asked++), 'should-not-be-used') };
    const outcome = await conductInterview('standard', ctx, prompter);
    expect(asked).toBe(0);
    expect(outcome.answers.goal).toBeUndefined(); // goal came from the base, not asked
  });
});

describe('interview — safety-critical blocking', () => {
  it('blocks a high-risk objective with no verification in auto mode', async () => {
    const ctx: InterviewContext = { base: baseFor('Implement authentication with password and payment'), detectedChecks: [], auto: true, interactive: false };
    await expect(conductInterview('quick', ctx)).rejects.toBeInstanceOf(IntakeError);
  });

  it('does NOT block once verification is supplied', async () => {
    const ctx: InterviewContext = { base: baseFor('Implement authentication with password and payment'), detectedChecks: [], auto: true, interactive: false };
    const outcome = await conductInterview('quick', ctx, undefined, { verificationCommands: ['npm test'] });
    expect(outcome.answers.verificationCommands).toEqual(['npm test']);
  });

  it('blocks when there is no goal at all', async () => {
    const ctx: InterviewContext = { detectedChecks: ['test'], auto: true, interactive: false };
    await expect(conductInterview('quick', ctx)).rejects.toBeInstanceOf(IntakeError);
  });
});

describe('interview — apply to objective (strengthen-only)', () => {
  it('idea + interview synthesizes a slice with acceptance criteria and applies risk/forbidden', async () => {
    const base = baseFor('Add a CSV export utility');
    const outcome = await conductInterview('standard', base ? { base, detectedChecks: [], auto: true, interactive: false } : { detectedChecks: [], auto: true, interactive: false }, undefined, {
      acceptanceCriteria: ['exports valid CSV', 'handles empty input'],
      verificationCommands: ['npm test'],
      forbiddenPaths: ['src/legacy/**'],
      risk: 'high',
      nonGoals: ['xlsx export'],
    });
    const applied = applyInterview(base, outcome);
    expect(applied.riskFloor).toBe('high');
    expect(applied.objective.nonGoals).toContain('xlsx export');
    // forbidden union INCLUDES the user path AND keeps built-in protections.
    expect(applied.objective.riskPolicy.globalForbiddenPaths).toContain('src/legacy/**');
    expect(applied.objective.riskPolicy.globalForbiddenPaths).toContain('.env');
    // verification command added.
    expect(applied.objective.verification.some((c) => String(c.command).includes('npm test'))).toBe(true);
    // a story now carries the acceptance criteria.
    expect(applied.stories[0]?.acceptanceCriteria).toEqual(['exports valid CSV', 'handles empty input']);

    const plan = buildPlan(applied.objective, applied.stories, {
      createdAt: '2026-01-01T00:00:00.000Z',
      branch: 'agent-loop/csv',
      ...(applied.riskFloor ? { riskFloor: applied.riskFloor } : {}),
    });
    expect(assertValidPlan(plan).ok).toBe(true);
    expect(plan.slices[0]!.risk).toBe('high'); // risk floor applied
    expect(plan.slices[0]!.acceptanceCriteria).toEqual(['exports valid CSV', 'handles empty input']);
  });

  it('PRD + interview preserves stories and raises their risk to the floor', async () => {
    const prd = JSON.stringify({
      description: 'Add priorities',
      userStories: [{ id: 'US1', title: 'Schema', description: 'migrate', acceptanceCriteria: ['migrate runs'], risk: 'low' }],
    });
    const base = baseFor(prd, 'prd-json');
    const outcome = await conductInterview('standard', { base, detectedChecks: [], auto: true, interactive: false }, undefined, {
      risk: 'medium',
      verificationCommands: ['npm test'],
    });
    const applied = applyInterview(base, outcome);
    const plan = buildPlan(applied.objective, applied.stories, {
      createdAt: '2026-01-01T00:00:00.000Z',
      branch: 'agent-loop/prio',
      ...(applied.riskFloor ? { riskFloor: applied.riskFloor } : {}),
    });
    expect(plan.slices.map((s) => s.title)).toEqual(['Schema']);
    expect(plan.slices[0]!.risk).toBe('medium'); // raised low → medium floor
    expect(assertValidPlan(plan).ok).toBe(true);
  });

  it('a declared LOW risk cannot lower the heuristic on a high-risk goal', async () => {
    // A user (or crafted --answers) tagging an auth/payment goal "low" must NOT
    // produce a low-risk slice — the heuristic floor still applies.
    const base = baseFor('Implement authentication with password and payment');
    const outcome = await conductInterview('standard', { base, detectedChecks: ['test'], auto: true, interactive: false }, undefined, {
      risk: 'low',
      acceptanceCriteria: ['login works'],
      verificationCommands: ['npm test'],
    });
    const applied = applyInterview(base, outcome);
    const plan = buildPlan(applied.objective, applied.stories, {
      createdAt: '2026-01-01T00:00:00.000Z',
      branch: 'agent-loop/auth',
      ...(applied.riskFloor ? { riskFloor: applied.riskFloor } : {}),
    });
    expect(plan.slices[0]!.risk).toBe('high'); // heuristic high, NOT lowered to low
  });

  it('blocks a high-risk goal even when the user declares risk=low (auto, no verification)', async () => {
    const base = baseFor('Implement authentication with password and payment');
    await expect(
      conductInterview('quick', { base, detectedChecks: [], auto: true, interactive: false }, undefined, { risk: 'low' }),
    ).rejects.toBeInstanceOf(IntakeError);
  });

  it('never removes a built-in forbidden path (cannot widen scope into secrets)', async () => {
    const base = baseFor('Add a small util');
    // Even with an empty forbidden answer, built-ins remain.
    const outcome = await conductInterview('standard', { base, detectedChecks: ['test'], auto: true, interactive: false });
    const applied = applyInterview(base, outcome);
    for (const builtin of ['.env', '.git/**', 'secrets/**']) {
      expect(applied.objective.riskPolicy.globalForbiddenPaths).toContain(builtin);
    }
  });

  it('produces a plan the user can edit and that still validates', async () => {
    const base = baseFor('Add a small util');
    const outcome = await conductInterview('standard', { base, detectedChecks: ['test'], auto: true, interactive: false }, undefined, {
      acceptanceCriteria: ['does the thing'],
    });
    const applied = applyInterview(base, outcome);
    const plan = buildPlan(applied.objective, applied.stories, { createdAt: '2026-01-01T00:00:00.000Z', branch: 'agent-loop/util' });
    // Simulate a human editing the persisted plan JSON, then re-validating.
    const edited = JSON.parse(JSON.stringify(plan));
    edited.slices[0].acceptanceCriteria.push('and another check');
    const reparsed = PlanSchema.parse(edited);
    expect(assertValidPlan(reparsed).ok).toBe(true);
    expect(reparsed.slices[0]!.acceptanceCriteria).toContain('and another check');
  });
});

describe('interview — clarification prompts (reused by GitHub triage)', () => {
  it('returns the missing-field questions for a mode', () => {
    const qs = clarificationPrompts('standard', { goal: true, acceptanceCriteria: true });
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.join(' ')).not.toMatch(/Acceptance criteria/); // already present → not asked
  });
});

// --- recommendations + agent/model orchestration -----------------------------

const PROVIDERS: ProviderInfo[] = [
  { id: 'fake', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer'] },
  { id: 'claude', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer', 'judge'] },
  { id: 'codex', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer'] },
];

function recInputsFor(goalText: string): RecommendInputs {
  const signals = computeSignals({
    goalText,
    stack: ['node', 'typescript', 'vitest'],
    packageManager: 'npm',
    packageScripts: ['test'],
    detectedChecks: ['test'],
    detectedCommands: ['npm test'],
    gitClean: true,
    gitBranch: 'main',
  });
  return { mode: 'standard', goalText, signals, providers: PROVIDERS, config: defaultConfig(), auto: false };
}

function recsForMode(mode: 'quick' | 'standard' | 'strict', ctx: InterviewContext, goalText: string): Map<keyof InterviewAnswers, Recommendation> {
  const questions = [...selectQuestions(mode, ctx), ...selectOrchestrationQuestions(mode, ctx)];
  return buildRecommendations(questions.map((q) => ({ key: q.key, prompt: q.prompt })), recInputsFor(goalText));
}

describe('interview — orchestration question selection', () => {
  it('quick asks NO orchestration questions; standard asks several; strict asks more', () => {
    const ctx: InterviewContext = { detectedChecks: [], auto: false, interactive: true };
    expect(selectOrchestrationQuestions('quick', ctx)).toHaveLength(0);
    const std = selectOrchestrationQuestions('standard', ctx).map((q) => q.key);
    expect(std).toEqual(expect.arrayContaining(['plannerProvider', 'workerProviders', 'concurrency', 'reviewerProvider']));
    expect(selectOrchestrationQuestions('strict', ctx).length).toBeGreaterThan(std.length);
  });

  it('does not change the objective question selection (back-compat)', () => {
    const ctx: InterviewContext = { detectedChecks: [], auto: false, interactive: true };
    expect(selectQuestions('quick', ctx).map((q) => q.key)).toEqual(['goal', 'acceptanceCriteria', 'verificationCommands']);
  });
});

describe('interview — accept-recommended fast path', () => {
  it('takes the recommended orchestration answers and records them as decisions', async () => {
    const base = baseFor('Add a CSV export utility');
    const ctx: InterviewContext = { base, detectedChecks: ['test'], auto: false, interactive: false };
    const recs = recsForMode('standard', ctx, 'Add a CSV export utility');
    const outcome = await conductInterview('standard', ctx, undefined, {}, {
      recommendations: recs,
      acceptRecommended: true,
      includeOrchestration: true,
    });
    // Orchestration answers taken from recommendations (claude installed → preferred).
    expect(outcome.answers.plannerProvider).toBe('claude');
    expect(outcome.answers.workerProviders).toEqual(['claude']);
    expect(outcome.answers.concurrency).toBe(1);
    // Low-risk goal → reviewer "none", attended.
    expect(outcome.answers.reviewerProvider).toBe('none');
    expect(outcome.answers.autonomous).toBe(false);
    // The decisions are explicitly recorded.
    expect(outcome.assumptions.some((a) => /Accepted recommended/.test(a.text))).toBe(true);
  });

  it('does NOT ask orchestration questions in pure --auto (config keeps defaults)', async () => {
    const base = baseFor('Add a CSV export utility');
    const ctx: InterviewContext = { base, detectedChecks: ['test'], auto: true, interactive: false };
    const recs = recsForMode('standard', ctx, 'Add a CSV export utility');
    const outcome = await conductInterview('standard', ctx, undefined, {}, { recommendations: recs, includeOrchestration: true });
    expect(outcome.answers.plannerProvider).toBeUndefined();
    expect(outcome.answers.concurrency).toBeUndefined();
  });
});

describe('interview — interactive recommendations (askRecommended)', () => {
  class RecPrompter implements Prompter {
    seen: string[] = [];
    constructor(private readonly typed: Partial<Record<string, string>>) {}
    async ask(): Promise<string> {
      return '';
    }
    async askRecommended(rec: Recommendation): Promise<string> {
      this.seen.push(String(rec.key));
      return this.typed[String(rec.key)] ?? ''; // empty → accept recommended
    }
  }

  it('renders recommendations, accepts on empty, and lets a typed answer override', async () => {
    const base = baseFor('Add a CSV export utility');
    const ctx: InterviewContext = { base, detectedChecks: ['test'], auto: false, interactive: true };
    const recs = recsForMode('standard', ctx, 'Add a CSV export utility');
    const prompter = new RecPrompter({ concurrency: '2', plannerProvider: 'codex' });
    const outcome = await conductInterview('standard', ctx, prompter, {}, {
      recommendations: recs,
      includeOrchestration: true,
    });
    expect(prompter.seen).toEqual(expect.arrayContaining(['plannerProvider', 'concurrency']));
    // Typed answers override the recommendation.
    expect(outcome.answers.concurrency).toBe(2);
    expect(outcome.answers.plannerProvider).toBe('codex');
    // Empty answer accepted the recommended worker.
    expect(outcome.answers.workerProviders).toEqual(['claude']);
  });
});

describe('interview — applyOrchestration (strengthen-only config override)', () => {
  it('builds roles/routing/execution/browser/github overrides from answers', () => {
    const answers: InterviewAnswers = {
      plannerProvider: 'claude',
      workerProviders: ['claude', 'codex'],
      concurrency: 2,
      reviewerProvider: 'codex',
      fallbackProvider: 'codex',
      switchOnRetry: true,
      browserVerification: true,
      browserRequired: true,
      githubIntegration: true,
    };
    const { override } = applyOrchestration(answers, { highRisk: false });
    expect((override.roles as Record<string, unknown>).planner).toEqual({ provider: 'claude' });
    expect((override.roles as Record<string, unknown>).workers).toEqual([{ provider: 'claude' }, { provider: 'codex' }]);
    expect((override.roles as Record<string, unknown>).reviewer).toEqual({ provider: 'codex' });
    expect((override.execution as Record<string, unknown>).concurrency).toBe(2);
    expect((override.routing as Record<string, unknown>).fallbackOrder).toEqual(['codex']);
    expect((override.routing as Record<string, unknown>).switchProviderOnRetry).toBe(true);
    expect(override.browser).toEqual({ enabled: true, required: true });
    expect((override.github as Record<string, unknown>).enabled).toBe(true);
  });

  it('parses provider:model refs', () => {
    const { override } = applyOrchestration({ plannerProvider: 'claude:opus-4', workerProviders: ['codex:gpt'] }, { highRisk: false });
    expect((override.roles as Record<string, unknown>).planner).toEqual({ provider: 'claude', model: 'opus-4' });
    expect((override.roles as Record<string, unknown>).workers).toEqual([{ provider: 'codex', model: 'gpt' }]);
  });

  it('NEVER enables autonomy on a high-risk objective (strengthen-only)', () => {
    const high = applyOrchestration({ autonomous: true }, { highRisk: true });
    expect(high.override.auto).toBeUndefined();
    expect(high.notes.some((n) => /Autonomy NOT enabled/i.test(n))).toBe(true);

    const low = applyOrchestration({ autonomous: true }, { highRisk: false });
    expect(low.override.auto).toBe(true);
  });

  it('ignores browserRequired unless browser verification is on', () => {
    expect(applyOrchestration({ browserRequired: true }, { highRisk: false }).override.browser).toBeUndefined();
    expect(applyOrchestration({ browserVerification: true, browserRequired: true }, { highRisk: false }).override.browser).toEqual({ enabled: true, required: true });
  });

  it('never selects the fake/none sentinels as real providers', () => {
    const { override } = applyOrchestration({ plannerProvider: 'fake', workerProviders: ['none'], reviewerProvider: 'none', fallbackProvider: 'none' }, { highRisk: false });
    expect(override.roles).toBeUndefined();
    expect(override.routing).toBeUndefined();
  });
});

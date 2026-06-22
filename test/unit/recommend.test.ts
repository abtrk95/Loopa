/**
 * Recommendation-engine unit tests. Pure logic: every interview question yields a
 * fully-explained recommendation (recommended/why/alternatives/risk/safeDefault/
 * required), grounded in the input + detected repo + risk + available providers.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSignals,
  recommendationFor,
  buildRecommendations,
  formatRecommendation,
  RECOMMENDABLE_OBJECTIVE_KEYS,
  RECOMMENDABLE_ORCHESTRATION_KEYS,
  type ProviderInfo,
  type RecommendInputs,
} from '../../src/intake/recommend.js';
import { defaultConfig } from '../../src/config/config.js';
import { ORCHESTRATION_CATALOG } from '../../src/intake/interview.js';

const PROVIDERS_BOTH: ProviderInfo[] = [
  { id: 'fake', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer'] },
  { id: 'claude', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer', 'judge'] },
  { id: 'codex', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer'] },
];
const PROVIDERS_NONE: ProviderInfo[] = [{ id: 'fake', installed: true, roles: ['planner', 'worker', 'reviewer', 'fixer'] }];

function inputs(over: Partial<RecommendInputs> & { goalText: string }): RecommendInputs {
  const signals = computeSignals({
    goalText: over.goalText,
    stack: ['node', 'typescript', 'vitest'],
    packageManager: 'npm',
    packageScripts: ['test', 'build', 'lint', 'typecheck'],
    detectedChecks: ['typecheck', 'lint', 'test', 'build'],
    detectedCommands: ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build'],
    gitClean: true,
    gitBranch: 'main',
  });
  return {
    mode: 'standard',
    goalText: over.goalText,
    signals: over.signals ?? signals,
    providers: over.providers ?? PROVIDERS_BOTH,
    config: over.config ?? defaultConfig(),
    auto: over.auto ?? false,
  };
}

describe('computeSignals — heuristics', () => {
  it('flags high risk on auth/payment goals', () => {
    const s = computeSignals({ goalText: 'Add authentication with password and billing', stack: [], packageScripts: [], detectedChecks: [], detectedCommands: [], gitClean: true });
    expect(s.highRisk).toBe(true);
  });
  it('flags UI signal on page/route/component goals', () => {
    const s = computeSignals({ goalText: 'Add a settings page with a form component', stack: [], packageScripts: [], detectedChecks: [], detectedCommands: [], gitClean: true });
    expect(s.uiSignal).toBe(true);
  });
  it('flags github signal when requested explicitly', () => {
    const s = computeSignals({ goalText: 'Add a util', stack: [], packageScripts: [], detectedChecks: [], detectedCommands: [], gitClean: true, githubRequested: true });
    expect(s.githubSignal).toBe(true);
  });
  it('flags multi-slice on compound goals', () => {
    const s = computeSignals({ goalText: 'Add a billing settings page with validation, tests, and docs', stack: [], packageScripts: [], detectedChecks: [], detectedCommands: [], gitClean: true });
    expect(s.multiSlice).toBe(true);
  });
});

describe('recommendationFor — objective questions', () => {
  it('recommends detected verification commands and explains why', () => {
    const rec = recommendationFor('verificationCommands', 'Verification commands?', inputs({ goalText: 'Add a CSV export utility' }))!;
    expect(rec.recommended).toContain('npm test');
    expect(rec.why).toMatch(/detected/i);
    expect(rec.section).toBe('objective');
  });
  it('recommends high risk for an auth goal, low for a plain util, and never lets risk be lowered', () => {
    expect(recommendationFor('risk', 'Risk?', inputs({ goalText: 'Implement authentication and payment' }))!.recommended).toBe('high');
    expect(recommendationFor('risk', 'Risk?', inputs({ goalText: 'Add a tiny string helper' }))!.recommended).toBe('low');
    expect(recommendationFor('risk', 'Risk?', inputs({ goalText: 'Implement authentication' }))!.risk).toMatch(/raised|never lowered/i);
  });
  it('recommends browser verification only when there is a UI signal', () => {
    expect(recommendationFor('browserVerification', 'Browser?', inputs({ goalText: 'Add a dashboard page' }))!.recommended).toBe('y');
    expect(recommendationFor('browserVerification', 'Browser?', inputs({ goalText: 'Refactor the parser' }))!.recommended).toBe('n');
  });
  it('always recommends attended (autonomous=n), with a stronger reason on high-risk', () => {
    const low = recommendationFor('autonomous', 'Autonomous?', inputs({ goalText: 'Add a helper' }))!;
    const high = recommendationFor('autonomous', 'Autonomous?', inputs({ goalText: 'Migrate the production database' }))!;
    expect(low.recommended).toBe('n');
    expect(high.recommended).toBe('n');
    expect(high.risk).toMatch(/high-risk/i);
  });
});

describe('recommendationFor — orchestration questions', () => {
  it('recommends the strongest installed real provider for the planner, claude preferred', () => {
    const rec = recommendationFor('plannerProvider', 'Planner?', inputs({ goalText: 'Add a feature' }))!;
    expect(rec.recommended).toBe('claude');
    expect(rec.section).toBe('orchestration');
  });
  it('falls back to fake with a clear warning when no real provider is installed', () => {
    const rec = recommendationFor('plannerProvider', 'Planner?', inputs({ goalText: 'Add a feature', providers: PROVIDERS_NONE }))!;
    expect(rec.recommended).toBe('fake');
    expect(rec.why).toMatch(/no real provider/i);
  });
  it('recommends a single worker and concurrency 1 (conservative), noting parallel risk', () => {
    const w = recommendationFor('workerProviders', 'Workers?', inputs({ goalText: 'Add a feature' }))!;
    const c = recommendationFor('concurrency', 'Concurrency?', inputs({ goalText: 'Add a feature' }))!;
    expect(w.recommended).toBe('claude');
    expect(c.recommended).toBe('1');
    expect(c.risk).toMatch(/serialize|parallel/i);
  });
  it('recommends a DISTINCT reviewer for high-risk work, none for low-risk', () => {
    const high = recommendationFor('reviewerProvider', 'Reviewer?', inputs({ goalText: 'Implement authentication and payment' }))!;
    const low = recommendationFor('reviewerProvider', 'Reviewer?', inputs({ goalText: 'Add a tiny helper' }))!;
    expect(high.recommended).not.toBe('none');
    expect(high.recommended).not.toBe('claude'); // distinct from the default worker (claude)
    expect(low.recommended).toBe('none');
    expect(high.risk).toMatch(/never.*override|verifier/i);
  });
  it('recommends a distinct fallback provider when two are installed', () => {
    const rec = recommendationFor('fallbackProvider', 'Fallback?', inputs({ goalText: 'Add a feature' }))!;
    expect(rec.recommended).toBe('codex'); // distinct from worker claude
    const none = recommendationFor('fallbackProvider', 'Fallback?', inputs({ goalText: 'Add a feature', providers: PROVIDERS_NONE }))!;
    expect(none.recommended).toBe('none');
  });
  it('recommends same-as-worker fixer by default', () => {
    expect(recommendationFor('fixerStrategy', 'Fixer?', inputs({ goalText: 'Add a feature' }))!.recommended).toBe('same-as-worker');
  });
});

describe('recommendation completeness + rendering', () => {
  it('every recommendable key yields all 7 fields populated', () => {
    const keys = [...RECOMMENDABLE_OBJECTIVE_KEYS, ...RECOMMENDABLE_ORCHESTRATION_KEYS];
    for (const key of keys) {
      const rec = recommendationFor(key, `Q for ${String(key)}`, inputs({ goalText: 'Add a billing settings page with validation and tests' }));
      expect(rec, `missing recommendation for ${String(key)}`).toBeDefined();
      expect(typeof rec!.why).toBe('string');
      expect(rec!.why.length).toBeGreaterThan(0);
      expect(typeof rec!.risk).toBe('string');
      expect(rec!.risk.length).toBeGreaterThan(0);
      expect(typeof rec!.safeDefault).toBe('string');
      expect(rec!.safeDefault.length).toBeGreaterThan(0);
      expect(Array.isArray(rec!.alternatives)).toBe(true);
      expect(typeof rec!.required).toBe('boolean');
    }
  });

  it('orchestration catalog keys all have a recommender', () => {
    for (const q of ORCHESTRATION_CATALOG) {
      expect(RECOMMENDABLE_ORCHESTRATION_KEYS, `no recommender for ${String(q.key)}`).toContain(q.key);
    }
  });

  it('formatRecommendation renders every labeled section', () => {
    const rec = recommendationFor('concurrency', 'How many slices in parallel?', inputs({ goalText: 'Add a feature' }))!;
    const text = formatRecommendation(rec);
    for (const label of ['Question:', 'Recommended:', 'Why:', 'Alternatives:', 'Risk:', 'Default:']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/Optional\.|Required\./);
  });

  it('buildRecommendations maps every question it is given', () => {
    const map = buildRecommendations(
      [{ key: 'risk', prompt: 'Risk?' }, { key: 'concurrency', prompt: 'Concurrency?' }],
      inputs({ goalText: 'Add auth' }),
    );
    expect(map.get('risk')!.recommended).toBe('high');
    expect(map.get('concurrency')!.recommended).toBe('1');
  });
});

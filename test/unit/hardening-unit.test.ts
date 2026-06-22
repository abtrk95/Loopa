/**
 * Unit regressions for the E2E-hardening fixes:
 *  - the CLI version is read from package.json (no hardcoded drift),
 *  - config riskPolicy is merged (and forbidden-path globs unioned) into the plan,
 *  - intake validates input at the boundary instead of producing bogus plans.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERSION } from '../../src/cli/index.js';
import { mergeRiskPolicy } from '../../src/orchestrator/planning.js';
import { normalizeInput } from '../../src/intake/normalize.js';
import { RiskPolicySchema } from '../../src/domain/schemas.js';
import { IntakeError } from '../../src/domain/errors.js';
import { tempRepo, cleanupRepos } from '../helpers.js';
import { afterEach } from 'vitest';

afterEach(cleanupRepos);

describe('CLI version is the real package version', () => {
  it('VERSION equals package.json version (no hardcoded drift)', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe('0.1.0'); // the old hardcoded value
  });
});

describe('mergeRiskPolicy', () => {
  it('takes config scalars and UNIONS forbidden-path globs (defaults never lost)', () => {
    const cfg = RiskPolicySchema.parse({ maxDiffLines: 123, allowLockfileChanges: false, globalForbiddenPaths: ['custom/**'] });
    const obj = RiskPolicySchema.parse({}); // intake default
    const merged = mergeRiskPolicy(cfg, obj);
    expect(merged.maxDiffLines).toBe(123);
    expect(merged.allowLockfileChanges).toBe(false);
    expect(merged.globalForbiddenPaths).toContain('custom/**'); // user glob honored
    expect(merged.globalForbiddenPaths).toContain('.env'); // built-in default preserved
    expect(merged.globalForbiddenPaths).toContain('secrets/**'); // hardened default preserved
  });
});

describe('intake boundary validation', () => {
  const root = (): string => tempRepo();
  const norm = (kind: 'idea' | 'prd-json' | 'prd-md', text: string): unknown =>
    normalizeInput({ kind, text }, { root: root(), auto: true });

  it('rejects empty input', () => {
    expect(() => norm('prd-md', '')).toThrow(IntakeError);
    expect(() => norm('prd-md', '   \n  ')).toThrow(IntakeError);
  });

  it('rejects a JSON array PRD (non-object)', () => {
    expect(() => norm('prd-json', '[]')).toThrow(IntakeError);
    expect(() => norm('prd-json', '[{"title":"x"}]')).toThrow(IntakeError);
  });

  it('rejects JSON null and invalid JSON', () => {
    expect(() => norm('prd-json', 'null')).toThrow(IntakeError);
    expect(() => norm('prd-json', '{not json')).toThrow(IntakeError);
  });

  it('rejects an empty-object PRD (no goal, no stories)', () => {
    expect(() => norm('prd-json', '{}')).toThrow(IntakeError);
    expect(() => norm('prd-json', '{"foo":"bar"}')).toThrow(IntakeError);
  });

  it('accepts valid inputs', () => {
    expect(() => norm('idea', 'Add a health check')).not.toThrow();
    expect(() => norm('prd-md', '# Title\n\nSome body.')).not.toThrow();
    expect(() => norm('prd-json', '{"description":"do a thing"}')).not.toThrow();
    expect(() =>
      norm('prd-json', '{"userStories":[{"id":"A","title":"t","acceptanceCriteria":["c"]}]}'),
    ).not.toThrow();
  });
});

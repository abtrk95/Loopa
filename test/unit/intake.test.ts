import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { normalizeInput } from '../../src/intake/normalize.js';

const opts = { root: tmpdir(), auto: true };

describe('intake normalization', () => {
  it('normalizes a short idea into an objective with recorded assumptions', () => {
    const { objective, stories } = normalizeInput({ kind: 'idea', text: 'Build a billing dashboard' }, opts);
    expect(objective.goal).toBe('Build a billing dashboard');
    expect(objective.assumptions.length).toBeGreaterThan(0);
    expect(stories).toHaveLength(0);
    expect(objective.source.kind).toBe('idea');
  });

  it('parses a JSON PRD (Ralph-style) into stories, skipping passed ones', () => {
    const text = JSON.stringify({
      description: 'Add priorities',
      userStories: [
        { id: 'US1', title: 'Schema', description: 'd', acceptanceCriteria: ['migrate'], priority: 1 },
        { id: 'US2', title: 'Done already', description: 'd', acceptanceCriteria: ['x'], passes: true },
      ],
    });
    const { objective, stories } = normalizeInput({ kind: 'prd-json', text }, opts);
    expect(objective.goal).toBe('Add priorities');
    expect(stories.map((s) => s.title)).toEqual(['Schema']); // passed story skipped
  });

  it('parses a Markdown PRD with a user-stories section', () => {
    const md = `# Billing dashboard\n\nSome background.\n\n## User Stories\n\n### Invoice table\nShow invoices.\n- renders rows\n- sortable\n\n### Currency formatting\n- formats USD\n`;
    const { objective, stories } = normalizeInput({ kind: 'prd-md', text: md }, opts);
    expect(objective.goal).toBe('Billing dashboard');
    expect(stories.map((s) => s.title)).toEqual(['Invoice table', 'Currency formatting']);
    expect(stories[0]!.acceptanceCriteria).toContain('renders rows');
  });

  it('parses a GitHub issue with checkbox acceptance criteria', () => {
    const { stories } = normalizeInput({ kind: 'issue', text: 'Add auth\n\n- [ ] login works\n- [x] logout works' }, opts);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.acceptanceCriteria).toEqual(['login works', 'logout works']);
  });

  it('sniffs stdin format (json vs markdown vs idea)', () => {
    // stdin records the SNIFFED kind so provenance reflects what was detected.
    expect(normalizeInput({ kind: 'stdin', text: '{"description":"x","userStories":[]}' }, opts).objective.source.kind).toBe('prd-json');
    const md = normalizeInput({ kind: 'stdin', text: '# Title\n\n## Acceptance Criteria\n- a\n- b' }, opts);
    expect(md.stories.length).toBeGreaterThanOrEqual(1);
  });
});

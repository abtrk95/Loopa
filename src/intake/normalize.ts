/**
 * Intake normalization: turn any accepted input (idea, Markdown/JSON PRD, spec,
 * README, GitHub issue, stdin) into a canonical Objective plus optional structured
 * stories for the planner. Ambiguity is handled by conservative, EXPLICITLY
 * RECORDED assumptions — never by silently inventing requirements.
 */
import type { Objective, Criterion } from '../domain/schemas.js';
import { ObjectiveSchema } from '../domain/schemas.js';
import { detectStack } from './detect.js';

export type InputKind = 'idea' | 'prd-md' | 'prd-json' | 'spec' | 'readme' | 'issue' | 'stdin';

export interface RawInput {
  kind: InputKind;
  text: string;
  ref?: string;
}

export interface RawStory {
  /** Original id from the source PRD (used to map dependencies to slice ids). */
  id?: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority?: number;
  dependencies?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  risk?: 'low' | 'medium' | 'high';
  parallelSafe?: boolean;
}

export interface NormalizeResult {
  objective: Objective;
  stories: RawStory[];
}

export interface NormalizeOptions {
  root: string;
  defaultBranch?: string;
  auto?: boolean;
}

export function normalizeInput(input: RawInput, opts: NormalizeOptions): NormalizeResult {
  const detected = detectStack(opts.root);
  const assumptions: string[] = [];
  const branch = opts.defaultBranch ?? 'main';
  if (!opts.defaultBranch) assumptions.push(`Assumed default branch '${branch}'.`);
  if (detected.verification.length > 0) {
    assumptions.push(
      `Derived verification commands from the project (${detected.verification.map((c) => c.id).join(', ')}).`,
    );
  } else {
    assumptions.push('No verification commands detected; relying on scope/secret/diff safety checks only.');
  }

  const effectiveKind = input.kind === 'stdin' ? sniffKind(input.text) : input.kind;
  const parsed = parseByKind(effectiveKind, input.text);
  if (parsed.stories.length === 0) {
    assumptions.push('No structured stories found; the planner will derive slices from the goal.');
  }

  const successCriteria: Criterion[] = detected.verification.map((c) => ({
    id: `crit-${c.id}`,
    type: 'programmatic' as const,
    description: `${c.id} passes`,
    check: c.command,
    expect: 'exit_zero' as const,
  }));

  const objective = ObjectiveSchema.parse({
    goal: parsed.goal,
    background: parsed.background,
    successCriteria,
    constraints: parsed.constraints,
    assumptions,
    nonGoals: parsed.nonGoals,
    repository: {
      root: opts.root,
      defaultBranch: branch,
      stack: detected.stack,
      ...(detected.packageManager ? { packageManager: detected.packageManager } : {}),
    },
    verification: detected.verification,
    finalCompletionCriteria: [
      'Every planned slice is verified-complete (deterministic checks passed + scoped commit exists).',
      ...(detected.verification.length ? ['Global verification commands all pass on the final tree.'] : []),
    ],
    source: { kind: input.kind === 'stdin' ? effectiveKind : input.kind, ...(input.ref ? { ref: input.ref } : {}) },
  });

  return { objective, stories: parsed.stories };
}

interface Parsed {
  goal: string;
  background: string;
  constraints: string[];
  nonGoals: string[];
  stories: RawStory[];
}

function sniffKind(text: string): InputKind {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'prd-json';
  if (/^#{1,3}\s/m.test(trimmed) || /^- \[[ xX]\]/m.test(trimmed)) return 'prd-md';
  return 'idea';
}

function parseByKind(kind: InputKind, text: string): Parsed {
  switch (kind) {
    case 'prd-json':
      return parseJsonPrd(text);
    case 'prd-md':
    case 'spec':
    case 'readme':
      return parseMarkdown(text);
    case 'issue':
      return parseIssue(text);
    case 'idea':
    case 'stdin':
    default:
      return { goal: firstLine(text) || text.trim(), background: '', constraints: [], nonGoals: [], stories: [] };
  }
}

function parseJsonPrd(text: string): Parsed {
  const json = JSON.parse(text) as Record<string, unknown>;
  const goal =
    str(json['goal']) ?? str(json['description']) ?? str(json['project']) ?? str(json['title']) ?? 'Implement the PRD';
  const background = str(json['background']) ?? '';
  const constraints = strArray(json['constraints']);
  const nonGoals = strArray(json['nonGoals']) ?? strArray(json['non_goals']) ?? [];
  const rawStories = (json['userStories'] ?? json['stories'] ?? json['slices'] ?? []) as unknown[];
  const stories: RawStory[] = [];
  for (const raw of Array.isArray(rawStories) ? rawStories : []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (str(r['passes']) === 'true' || r['passes'] === true) continue; // already done (Ralph style)
    stories.push({
      ...(str(r['id']) ? { id: str(r['id']) } : {}),
      title: str(r['title']) ?? str(r['id']) ?? 'Untitled',
      description: str(r['description']) ?? '',
      acceptanceCriteria: strArray(r['acceptanceCriteria']) ?? strArray(r['acceptance_criteria']) ?? [],
      ...(num(r['priority']) !== undefined ? { priority: num(r['priority']) } : {}),
      ...(strArray(r['dependencies']) ? { dependencies: strArray(r['dependencies']) } : {}),
      ...(strArray(r['allowedPaths']) ? { allowedPaths: strArray(r['allowedPaths']) } : {}),
      ...(strArray(r['forbiddenPaths']) ? { forbiddenPaths: strArray(r['forbiddenPaths']) } : {}),
      ...(isRisk(r['risk']) ? { risk: r['risk'] as RawStory['risk'] } : {}),
      ...(typeof r['parallelSafe'] === 'boolean' ? { parallelSafe: r['parallelSafe'] } : {}),
    });
  }
  return { goal, background, constraints: constraints ?? [], nonGoals, stories };
}

function parseMarkdown(text: string): Parsed {
  const lines = text.split('\n');
  const goal = (lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim()) || firstLine(text);
  const sections = splitSections(text);
  const constraints = bulletsUnder(sections, /constraints?/i);
  const nonGoals = bulletsUnder(sections, /non[- ]?goals?/i);
  const stories: RawStory[] = [];

  // Stories: subsections under a "User Stories"/"Stories"/"Requirements" heading,
  // OR top-level "### " headings that carry acceptance criteria.
  for (const sec of sections) {
    if (/user stories|^stories|requirements|slices|tasks/i.test(sec.heading)) {
      for (const sub of sec.subsections) {
        const ac = bulletList(sub.body).filter(Boolean);
        if (sub.heading) {
          stories.push({ title: sub.heading, description: firstParagraph(sub.body), acceptanceCriteria: ac });
        }
      }
    }
  }
  // Fallback: a single global "Acceptance Criteria" list becomes one story.
  if (stories.length === 0) {
    const ac = bulletsUnder(sections, /acceptance criteria/i);
    if (ac.length > 0) {
      stories.push({ title: goal || 'Implement', description: firstParagraph(text), acceptanceCriteria: ac });
    }
  }
  return { goal: goal || 'Implement the document', background: firstParagraph(text), constraints, nonGoals, stories };
}

function parseIssue(text: string): Parsed {
  const goal = firstLine(text);
  const checkboxes = text
    .split('\n')
    .filter((l) => /^\s*- \[[ xX]\]/.test(l))
    .map((l) => l.replace(/^\s*- \[[ xX]\]\s*/, '').trim());
  const stories: RawStory[] =
    checkboxes.length > 0 ? [{ title: goal, description: text.trim(), acceptanceCriteria: checkboxes }] : [];
  return { goal, background: text.trim(), constraints: [], nonGoals: [], stories };
}

// --- small parsing helpers ---------------------------------------------------

interface Section {
  heading: string;
  body: string;
  level: number;
  subsections: Section[];
}

function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const top: Section[] = [];
  let current: Section | undefined;
  let sub: Section | undefined;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)/);
    const h3 = line.match(/^###\s+(.*)/);
    if (h2) {
      current = { heading: h2[1]!.trim(), body: '', level: 2, subsections: [] };
      sub = undefined;
      top.push(current);
    } else if (h3 && current) {
      sub = { heading: h3[1]!.trim(), body: '', level: 3, subsections: [] };
      current.subsections.push(sub);
    } else if (sub) {
      sub.body += line + '\n';
    } else if (current) {
      current.body += line + '\n';
    }
  }
  return top;
}

function bulletsUnder(sections: Section[], re: RegExp): string[] {
  for (const s of sections) if (re.test(s.heading)) return bulletList(s.body);
  return [];
}
function bulletList(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+(\[[ xX]\]\s*)?/, '').trim())
    .filter(Boolean);
}
function firstParagraph(text: string): string {
  for (const para of text.split('\n\n')) {
    const cleaned = para.replace(/^#.*$/gm, '').trim();
    if (cleaned) return cleaned.split('\n').filter((l) => !/^\s*[-*]/.test(l)).join(' ').trim();
  }
  return '';
}
function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? text.split('\n')[0] ?? '').replace(/^#+\s*/, '').trim();
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return undefined;
}
function isRisk(v: unknown): boolean {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * Pure dashboard renderer. Given a model (derived from the event store + live git)
 * and layout options, returns the full screen as a string. Being pure makes it
 * snapshot-testable and guarantees the watcher never mutates state while drawing.
 *
 * Everything shown is derived from raw signals — the event log, git, the process
 * manager, and check results — never from agent-authored progress text.
 */
import type { AgentLoopEvent } from '../events/types.js';
import { progressPercent, type RunSnapshot, type CheckView } from '../events/projection.js';

export interface WatchModel {
  snapshot: RunSnapshot;
  git: { branch: string; clean: boolean; uncommitted: number; lastCommit?: { sha: string; message: string } | undefined };
  recentEvents: AgentLoopEvent[];
  providerHealth?: Array<{ id: string; ok: boolean }> | undefined;
  nowMs: number;
}

export interface RenderOptions {
  width: number;
  color: boolean;
  compact?: boolean;
}

const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function paint(text: string, code: string, on: boolean): string {
  return on ? `${code}${text}${A.reset}` : text;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
function vlen(s: string): number {
  return stripAnsi(s).length;
}
function padEnd(s: string, width: number): string {
  const pad = width - vlen(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}
function truncate(s: string, width: number): string {
  if (vlen(s) <= width) return s;
  // truncate on stripped string (we only truncate uncolored content here)
  return stripAnsi(s).slice(0, Math.max(0, width - 1)) + '…';
}

function statusColor(state: string): string {
  switch (state) {
    case 'RUNNING':
    case 'COMPLETED':
      return A.green;
    case 'PAUSED':
    case 'BLOCKED':
    case 'FINAL_VERIFYING':
      return A.yellow;
    case 'FAILED':
    case 'CANCELLED':
      return A.red;
    default:
      return A.cyan;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

export function progressBar(fraction: number, width: number, color: boolean): string {
  const inner = Math.max(4, width);
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * inner);
  const bar = '█'.repeat(filled) + ' '.repeat(inner - filled);
  return paint(bar, A.green, color);
}

/** Build a titled box of a fixed inner width. An optional pre-colored rightLabel
 * (e.g. the run status) is placed on the right end of the top border. */
function box(title: string, body: string[], innerWidth: number, opts: RenderOptions, titleColor = A.cyan, rightLabel?: string): string[] {
  const t = paint(title, titleColor + A.bold, opts.color);
  const left = `┌ ${t} `;
  const right = rightLabel ? ` ${rightLabel} ┐` : '┐';
  const dashCount = Math.max(0, innerWidth + 2 - vlen(left) - vlen(right));
  const top = `${left}${'─'.repeat(dashCount)}${right}`;
  const lines = body.map((l) => `│ ${padEnd(truncate(l, innerWidth - 2), innerWidth - 2)} │`);
  const bottom = `└${'─'.repeat(innerWidth)}┘`;
  return [top, ...lines, bottom];
}

/** Join boxes horizontally, padding to equal height. */
function hjoin(boxes: string[][], gap = 1): string[] {
  const height = Math.max(...boxes.map((b) => b.length));
  const widths = boxes.map((b) => Math.max(...b.map((l) => vlen(l))));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const parts = boxes.map((b, bi) => padEnd(b[i] ?? '', widths[bi]!));
    out.push(parts.join(' '.repeat(gap)));
  }
  return out;
}

function checkLine(c: CheckView, color: boolean): string {
  const label = padEnd(c.id, 14);
  if (c.state === 'passed') return `${label}${paint('✓', A.green, color)}`;
  if (c.state === 'failed') return `${label}${paint('✗', A.red, color)}`;
  const dur = c.durationMs ? ` ${Math.round(c.durationMs / 1000)}s` : '';
  return `${label}${paint('running' + dur, A.yellow, color)}`;
}

export function summarizeEvent(ev: AgentLoopEvent): string {
  const p = ev.payload;
  switch (ev.type) {
    case 'FILE_CHANGED':
      return `${(p['files'] as unknown[] | undefined)?.length ?? 0} file(s)`;
    case 'CHECK_STARTED':
      return String(p['command'] ?? p['checkId'] ?? '');
    case 'CHECK_FINISHED':
      return `${p['checkId']} ${p['ok'] ? 'ok' : 'fail'}`;
    case 'COMMIT_CREATED':
      return `${String(p['sha'] ?? '').slice(0, 8)} ${String(p['message'] ?? '')}`;
    case 'PROVIDER_SELECTED':
      return `${p['role']} → ${p['provider']}`;
    case 'SLICE_BLOCKED':
      return String(p['reason'] ?? '');
    case 'SLICE_STATE_CHANGED':
      return `${ev.sliceId} ${p['to']}`;
    default:
      return ev.sliceId ?? '';
  }
}

function eventColor(type: string): string {
  if (type.includes('FAILED') || type.includes('BLOCKED')) return A.red;
  if (type.includes('PASSED') || type.includes('COMPLETED') || type === 'COMMIT_CREATED') return A.green;
  if (type.startsWith('CHECK')) return A.yellow;
  if (type === 'FILE_CHANGED') return A.green;
  return A.cyan;
}

export function renderDashboard(model: WatchModel, opts: RenderOptions): string {
  const { snapshot: s } = model;
  const width = Math.max(40, opts.width);
  const inner = width - 2;
  const compact = opts.compact ?? width < 90;
  const lines: string[] = [];

  // --- header box ---
  const status = paint(s.runState, statusColor(s.runState) + A.bold, opts.color);
  const runtime = formatDuration((s.startedAtMs ? model.nowMs - s.startedAtMs : 0));
  const pct = progressPercent(s);
  const barWidth = Math.max(8, Math.min(28, inner - 40));
  const header: string[] = [
    `${paint('Goal:', A.blue, opts.color)}   ${truncate(s.goal || '(no goal)', inner - 10)}`,
    `${paint('Branch:', A.blue, opts.color)} ${truncate(s.branch || model.git.branch || '(none)', inner - 12)}`,
    `${paint('Runtime:', A.blue, opts.color)} ${runtime}   ${paint('Progress:', A.blue, opts.color)} ${s.verifiedCompleted} / ${s.totalSlices} slices done`,
    `[${progressBar(s.progressFraction, barWidth, opts.color)}] ${pct}%`,
    paint('Progress is derived from runtime signals: git state, file changes, and verifier checks.', A.dim, opts.color),
  ];
  lines.push(...box('agent-loop watch', header, inner, opts, statusColor(s.runState), status));
  lines.push('');

  // --- current slice / checks / changed files ---
  const cur = s.currentSliceId ? s.slices[s.currentSliceId] : undefined;
  const sliceBody = [
    cur ? paint(`${cur.id} ${cur.title}`, A.green + A.bold, opts.color) : '(no active slice)',
    `Phase:  ${paint(s.currentPhase ?? '—', A.yellow, opts.color)}`,
    `Worker: ${cur?.provider ?? s.currentProvider ?? '—'}${cur?.model ? ' (' + cur.model + ')' : ''}`,
    `Attempt: ${cur?.attempts ?? 0}   Retries: ${cur?.retries ?? 0}`,
  ];
  const checksBody = s.checks.length ? s.checks.map((c) => checkLine(c, opts.color)) : ['(no checks yet)'];
  const filesBody = s.changedFiles.length
    ? s.changedFiles.slice(0, 8).map((f, i) => `${paint(String(i + 1), A.blue, opts.color)} ${f}`)
    : ['(no changes)'];

  if (compact) {
    lines.push(...box('CURRENT SLICE', sliceBody, inner, opts, A.green));
    lines.push(...box('CHECKS', checksBody, inner, opts, A.yellow));
    lines.push(...box(`CHANGED FILES (${s.changedFiles.length})`, filesBody, inner, opts, A.blue));
  } else {
    // 3 boxes + 2 single-space gaps must fit `width` (= inner+2). Each box adds 2
    // border cols, so the inner widths sum to inner-6.
    const budget = inner - 6;
    const colW = Math.floor(budget / 3);
    lines.push(
      ...hjoin([
        box('CURRENT SLICE', sliceBody, colW, opts, A.green),
        box('CHECKS', checksBody, colW, opts, A.yellow),
        box(`CHANGED FILES (${s.changedFiles.length})`, filesBody, budget - 2 * colW, opts, A.blue),
      ]),
    );
  }
  lines.push('');

  // --- recent events / git ---
  const eventsBody = model.recentEvents
    .slice(-6)
    .map((ev) => {
      const time = ev.ts.slice(11, 19);
      const type = paint(ev.type.padEnd(16), eventColor(ev.type), opts.color);
      return `${paint(time, A.gray, opts.color)} ${type} ${summarizeEvent(ev)}`;
    });
  if (eventsBody.length === 0) eventsBody.push('(no events yet)');
  const gitBody = [
    `clean working tree: ${model.git.clean ? paint('yes', A.green, opts.color) : paint('no', A.red, opts.color)}`,
    `uncommitted files:  ${model.git.uncommitted}`,
    model.git.lastCommit
      ? `last commit: ${paint(model.git.lastCommit.sha.slice(0, 8), A.cyan, opts.color)} ${truncate(model.git.lastCommit.message, inner / 2 - 16)}`
      : 'last commit: —',
    ...(s.blocker ? [paint(`blocker: ${s.blocker.reason}`, A.red, opts.color)] : []),
    ...(model.providerHealth && model.providerHealth.length
      ? ['providers: ' + model.providerHealth.map((p) => `${p.id}${p.ok ? '✓' : '✗'}`).join(' ')]
      : []),
    ...(s.costUsd > 0 || s.tokens > 0 ? [`cost: $${s.costUsd.toFixed(4)} / ${s.tokens} tok`] : []),
  ];

  if (compact) {
    lines.push(...box('RECENT EVENTS', eventsBody, inner, opts, A.blue));
    lines.push(...box('GIT', gitBody, inner, opts, A.blue));
  } else {
    // 2 boxes + 1 gap fit `width`; inner widths sum to inner-3.
    const budget = inner - 3;
    const half = Math.floor(budget / 2);
    lines.push(...hjoin([box('RECENT EVENTS', eventsBody, half, opts, A.blue), box('GIT', gitBody, budget - half, opts, A.blue)]));
  }
  lines.push('');

  // --- footer (responsive: shrink on narrow terminals) ---
  const longFooter = `${key('p', opts)} pause   ${key('r', opts)} resume   ${key('l', opts)} logs   ${key('g', opts)} diff   ${key('q', opts)} quit`;
  const shortFooter = `${key('p', opts)}ause ${key('r', opts)}esume ${key('l', opts)}ogs ${key('g', opts)}diff ${key('q', opts)}uit`;
  lines.push(vlen(longFooter) <= width ? longFooter : shortFooter);

  return lines.join('\n');
}

function key(k: string, opts: RenderOptions): string {
  return `[${paint(k, A.bold, opts.color)}]`;
}

/** Plain (no box) renderer for non-TTY / --plain. */
export function renderPlain(model: WatchModel): string {
  const s = model.snapshot;
  const lines = [
    `agent-loop watch — ${s.runState}`,
    `goal: ${s.goal}`,
    `branch: ${s.branch || model.git.branch}`,
    `progress: ${s.verifiedCompleted}/${s.totalSlices} (${progressPercent(s)}%)  runtime ${formatDuration(s.startedAtMs ? model.nowMs - s.startedAtMs : 0)}`,
    `current: ${s.currentSliceId ?? '—'} phase=${s.currentPhase ?? '—'} provider=${s.currentProvider ?? '—'}`,
    `checks: ${s.checks.map((c) => `${c.id}:${c.state}`).join(' ') || '—'}`,
    `changed files: ${s.changedFiles.length}`,
    `git: ${model.git.clean ? 'clean' : 'dirty'} uncommitted=${model.git.uncommitted} lastCommit=${model.git.lastCommit?.sha.slice(0, 8) ?? '—'}`,
    ...(s.blocker ? [`blocker: ${s.blocker.reason}`] : []),
    `recent: ${model.recentEvents.slice(-4).map((e) => e.type).join(', ')}`,
  ];
  return lines.join('\n');
}

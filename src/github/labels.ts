/**
 * Label + Kanban-status vocabulary and the mappings between the local run state
 * machine and GitHub labels / project columns.
 *
 * Labels are an OBSERVABILITY PROJECTION of the local run state — never the source
 * of truth. The deterministic verifier and the event log remain authoritative;
 * these helpers only decide which label/column reflects that state.
 */
import type { GithubConfig, GithubLabels } from '../config/config.js';
import type { RunState } from '../domain/states.js';

export type TriageStatus = 'ready' | 'needs-info' | 'too-risky' | 'unsupported';

/** Suggested Kanban columns (GitHub Project single-select "Status" options). */
export const PROJECT_STATUSES = [
  'Inbox',
  'Needs Info',
  'Ready',
  'Planning',
  'Running',
  'Blocked',
  'Review',
  'Done',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** Status + classification labels triage manages. */
export function statusLabels(l: GithubLabels): string[] {
  return unique([l.ready, l.needsInfo, l.planning, l.planReady, l.running, l.blocked, l.review, l.done, l.error, l.tooRisky, l.unsupported]);
}

/** Role/stage labels (plan/work/review/fix) inspired by Looper-main. */
export function roleLabels(l: GithubLabels): string[] {
  return unique([l.plan, l.work, l.review, l.fix]);
}

/** Every label agent-loop may add/remove on an issue. */
export function allManagedLabels(l: GithubLabels): string[] {
  return unique([...statusLabels(l), ...roleLabels(l)]);
}

/** The labels that mark an issue as an agent-loop candidate for triage. */
export function triggerLabels(cfg: GithubConfig): string[] {
  return cfg.triage.triggerLabels.length ? unique(cfg.triage.triggerLabels) : unique([cfg.labels.ready, cfg.labels.plan, cfg.labels.work]);
}

/** The label that records a triage classification. */
export function labelForTriage(status: TriageStatus, l: GithubLabels): string {
  switch (status) {
    case 'ready':
      return l.ready;
    case 'needs-info':
      return l.needsInfo;
    case 'too-risky':
      return l.tooRisky;
    case 'unsupported':
      return l.unsupported;
  }
}

/** The status label to apply on the source issue for a given run state. */
export function statusLabelForRunState(state: RunState, l: GithubLabels): string | undefined {
  switch (state) {
    case 'PLAN_READY':
      return l.planReady;
    case 'RUNNING':
    case 'FINAL_VERIFYING':
    case 'PAUSED':
      return l.running;
    case 'BLOCKED':
      return l.blocked;
    case 'COMPLETED':
      return l.done;
    case 'FAILED':
    case 'CANCELLED':
      return l.error;
    default:
      return undefined;
  }
}

/** The Kanban column for a triage classification. */
export function projectStatusForTriage(status: TriageStatus): ProjectStatus {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'needs-info':
      return 'Needs Info';
    case 'too-risky':
      return 'Blocked';
    case 'unsupported':
      return 'Inbox';
  }
}

/** The Kanban column for a run state. */
export function projectStatusForRunState(state: RunState): ProjectStatus {
  switch (state) {
    case 'PLAN_READY':
      return 'Planning';
    case 'RUNNING':
    case 'FINAL_VERIFYING':
    case 'PAUSED':
      return 'Running';
    case 'BLOCKED':
      return 'Blocked';
    case 'COMPLETED':
      return 'Done';
    case 'FAILED':
    case 'CANCELLED':
      return 'Blocked';
    default:
      return 'Inbox';
  }
}

/** Color hints used when creating labels (best-effort). */
export const LABEL_COLORS: Record<string, string> = {
  ready: '0e8a16',
  'needs-info': 'fbca04',
  planning: '1d76db',
  'plan-ready': '0052cc',
  running: '5319e7',
  blocked: 'b60205',
  review: 'd93f0b',
  done: '0e8a16',
  error: 'b60205',
  'too-risky': 'b60205',
  unsupported: 'cccccc',
  plan: '1d76db',
  work: '5319e7',
  fix: 'd93f0b',
};

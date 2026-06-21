/**
 * Pure projection: fold the event log into a RunSnapshot. This is how progress is
 * computed — from objective recorded events, never from agent claims. The same
 * fold runs in the engine, in `status`, and in the watcher, guaranteeing they all
 * agree. The function is deterministic: same events in → same snapshot out.
 *
 * Progress is defined as `verifiedCompleted / totalSlices`, where a slice is
 * "verified completed" only when it reached the COMPLETED state (which the engine
 * only enters after deterministic verification passed and a scoped commit exists).
 */
import type { AgentLoopEvent } from './types.js';
import type { RunState, SliceState } from '../domain/states.js';

export interface CheckView {
  id: string;
  command: string;
  state: 'running' | 'passed' | 'failed';
  durationMs?: number;
  summary?: string;
}

export interface SliceView {
  id: string;
  title: string;
  state: SliceState;
  role?: string;
  provider?: string;
  model?: string;
  attempts: number;
  retries: number;
  lastCommit?: string;
}

export interface BlockerView {
  sliceId?: string;
  reason: string;
  details?: string;
}

export interface RunSnapshot {
  runId: string;
  runState: RunState;
  goal: string;
  branch: string;
  planId?: string;
  startedAtMs?: number;
  lastEventAtMs?: number;
  totalSlices: number;
  verifiedCompleted: number;
  progressFraction: number;
  sliceOrder: string[];
  slices: Record<string, SliceView>;
  currentSliceId?: string;
  currentPhase?: string;
  currentProvider?: string;
  currentModel?: string;
  activeProcess?: { command: string; pid?: number };
  checks: CheckView[];
  changedFiles: string[];
  lastCommit?: { sha: string; message: string };
  blocker?: BlockerView;
  assumptions: string[];
  costUsd: number;
  tokens: number;
  /** True once a terminal run state is reached. */
  finished: boolean;
}

const PHASE_LABEL: Partial<Record<SliceState, string>> = {
  PENDING: 'pending',
  READY: 'ready',
  PREPARING: 'preparing',
  EXECUTING: 'working',
  VERIFYING: 'verifying',
  REVIEWING: 'reviewing',
  FIXING: 'fixing',
  COMMITTING: 'committing',
  RETRY_PENDING: 'retry pending',
  BLOCKED: 'blocked',
};

function s(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' ? v : undefined;
}
function n(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === 'number' ? v : undefined;
}

function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

export function project(events: readonly AgentLoopEvent[]): RunSnapshot {
  const snap: RunSnapshot = {
    runId: events[0]?.runId ?? '',
    runState: 'CREATED',
    goal: '',
    branch: '',
    totalSlices: 0,
    verifiedCompleted: 0,
    progressFraction: 0,
    sliceOrder: [],
    slices: {},
    checks: [],
    changedFiles: [],
    assumptions: [],
    costUsd: 0,
    tokens: 0,
    finished: false,
  };

  const ensureSlice = (id: string): SliceView => {
    let view = snap.slices[id];
    if (!view) {
      view = { id, title: id, state: 'PENDING', attempts: 0, retries: 0 };
      snap.slices[id] = view;
      if (!snap.sliceOrder.includes(id)) snap.sliceOrder.push(id);
    }
    return view;
  };

  for (const ev of events) {
    snap.lastEventAtMs = parseTs(ev.ts);
    const p = ev.payload;
    switch (ev.type) {
      case 'RUN_CREATED':
        snap.runState = 'CREATED';
        snap.goal = s(p, 'goal') ?? snap.goal;
        break;
      case 'OBJECTIVE_CREATED':
        snap.goal = s(p, 'goal') ?? snap.goal;
        break;
      case 'PLAN_CREATED': {
        snap.planId = s(p, 'planId') ?? snap.planId;
        snap.goal = s(p, 'goal') ?? snap.goal;
        snap.branch = s(p, 'branch') ?? snap.branch;
        const total = n(p, 'totalSlices');
        if (total !== undefined) snap.totalSlices = total;
        const ids = p['sliceIds'];
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === 'string') ensureSlice(id);
        }
        const titles = p['sliceTitles'];
        if (titles && typeof titles === 'object') {
          for (const [id, t] of Object.entries(titles as Record<string, unknown>)) {
            if (typeof t === 'string') ensureSlice(id).title = t;
          }
        }
        break;
      }
      case 'RUN_STARTED':
        snap.runState = 'RUNNING';
        if (snap.startedAtMs === undefined) snap.startedAtMs = parseTs(ev.ts);
        snap.branch = s(p, 'branch') ?? snap.branch;
        break;
      case 'RUN_STATE_CHANGED': {
        const to = s(p, 'to') as RunState | undefined;
        if (to) snap.runState = to;
        break;
      }
      case 'RUN_PAUSED':
        snap.runState = 'PAUSED';
        break;
      case 'RUN_RESUMED':
        snap.runState = 'RUNNING';
        break;
      case 'FINAL_VERIFICATION_STARTED':
        snap.runState = 'FINAL_VERIFYING';
        break;
      case 'RUN_COMPLETED':
        snap.runState = 'COMPLETED';
        snap.finished = true;
        break;
      case 'RUN_FAILED':
        snap.runState = 'FAILED';
        snap.finished = true;
        break;
      case 'RUN_CANCELLED':
        snap.runState = 'CANCELLED';
        snap.finished = true;
        break;
      case 'ASSUMPTION_RECORDED': {
        const text = s(p, 'text');
        if (text) snap.assumptions.push(text);
        break;
      }
      case 'SLICE_READY': {
        if (ev.sliceId) {
          const view = ensureSlice(ev.sliceId);
          view.state = 'READY';
          const title = s(p, 'title');
          if (title) view.title = title;
        }
        break;
      }
      case 'SLICE_STARTED': {
        if (ev.sliceId) {
          snap.currentSliceId = ev.sliceId;
          const view = ensureSlice(ev.sliceId);
          view.attempts += 1;
        }
        break;
      }
      case 'SLICE_STATE_CHANGED': {
        if (ev.sliceId) {
          const to = s(p, 'to') as SliceState | undefined;
          const view = ensureSlice(ev.sliceId);
          if (to) view.state = to;
          if (to && !isTerminalLike(to)) snap.currentSliceId = ev.sliceId;
          if (to) snap.currentPhase = PHASE_LABEL[to] ?? to.toLowerCase();
        }
        break;
      }
      case 'PROVIDER_SELECTED': {
        if (ev.sliceId) {
          const view = ensureSlice(ev.sliceId);
          view.role = s(p, 'role') ?? view.role;
          view.provider = s(p, 'provider') ?? view.provider;
          view.model = s(p, 'model') ?? view.model;
          if (ev.sliceId === snap.currentSliceId) {
            snap.currentProvider = view.provider;
            snap.currentModel = view.model;
          }
        }
        break;
      }
      case 'AGENT_PROCESS_STARTED': {
        const command = s(p, 'command');
        if (command) {
          snap.activeProcess = { command };
          const pid = n(p, 'pid');
          if (pid !== undefined) snap.activeProcess.pid = pid;
        }
        break;
      }
      case 'AGENT_PROCESS_EXITED': {
        snap.activeProcess = undefined;
        snap.costUsd += n(p, 'costUsd') ?? 0;
        snap.tokens += n(p, 'tokens') ?? 0;
        break;
      }
      case 'FILE_CHANGED': {
        const files = p['files'];
        if (Array.isArray(files)) {
          snap.changedFiles = files.filter((f): f is string => typeof f === 'string');
        }
        break;
      }
      case 'VERIFICATION_STARTED':
        snap.checks = [];
        snap.currentPhase = 'verifying';
        break;
      case 'CHECK_STARTED': {
        const id = s(p, 'checkId') ?? s(p, 'id');
        if (id) {
          const command = s(p, 'command') ?? id;
          const existing = snap.checks.find((c) => c.id === id);
          if (existing) {
            existing.state = 'running';
          } else {
            snap.checks.push({ id, command, state: 'running' });
          }
        }
        break;
      }
      case 'CHECK_OUTPUT': {
        const id = s(p, 'checkId') ?? s(p, 'id');
        const check = snap.checks.find((c) => c.id === id);
        if (check) check.summary = s(p, 'summary');
        break;
      }
      case 'CHECK_FINISHED': {
        const id = s(p, 'checkId') ?? s(p, 'id');
        const check = snap.checks.find((c) => c.id === id);
        if (check) {
          check.state = p['ok'] === true ? 'passed' : 'failed';
          const dur = n(p, 'durationMs');
          if (dur !== undefined) check.durationMs = dur;
        }
        break;
      }
      case 'COMMIT_CREATED': {
        const sha = s(p, 'sha');
        const message = s(p, 'message') ?? '';
        if (sha) {
          snap.lastCommit = { sha, message };
          if (ev.sliceId) ensureSlice(ev.sliceId).lastCommit = sha;
        }
        break;
      }
      case 'SLICE_COMPLETED': {
        if (ev.sliceId) ensureSlice(ev.sliceId).state = 'COMPLETED';
        break;
      }
      case 'SLICE_RETRY_SCHEDULED': {
        if (ev.sliceId) ensureSlice(ev.sliceId).retries += 1;
        break;
      }
      case 'SLICE_BLOCKED': {
        const reason = s(p, 'reason') ?? 'unknown';
        snap.blocker = {
          ...(ev.sliceId ? { sliceId: ev.sliceId } : {}),
          reason,
          ...(s(p, 'details') ? { details: s(p, 'details')! } : {}),
        };
        if (ev.sliceId) ensureSlice(ev.sliceId).state = 'BLOCKED';
        break;
      }
      default:
        break;
    }
  }

  snap.verifiedCompleted = Object.values(snap.slices).filter((sl) => sl.state === 'COMPLETED').length;
  if (snap.totalSlices === 0) snap.totalSlices = snap.sliceOrder.length;
  snap.progressFraction =
    snap.totalSlices > 0 ? snap.verifiedCompleted / snap.totalSlices : 0;
  return snap;
}

function isTerminalLike(state: SliceState): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED' || state === 'BLOCKED';
}

/** Convenience: percent 0–100 rounded for display. */
export function progressPercent(snap: RunSnapshot): number {
  return Math.round(snap.progressFraction * 100);
}

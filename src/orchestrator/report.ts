/**
 * Run report generation. The report is derived entirely from the authoritative
 * event-sourced snapshot (never from agent text), so it is an honest record of
 * what was objectively verified.
 */
import { join } from 'node:path';
import { atomicWrite, atomicWriteJson } from '../util/fs.js';
import type { Session } from './session.js';
import type { Plan } from '../domain/schemas.js';
import { progressPercent, type RunSnapshot } from '../events/projection.js';

export function generateReport(session: Session, plan: Plan, snap: RunSnapshot): string {
  const lines: string[] = [];
  lines.push(`# agent-loop run report`);
  lines.push('');
  lines.push(`- **Run:** ${snap.runId}`);
  lines.push(`- **State:** ${snap.runState}`);
  lines.push(`- **Goal:** ${snap.goal || plan.goal}`);
  lines.push(`- **Branch:** ${snap.branch}`);
  lines.push(`- **Progress:** ${snap.verifiedCompleted} / ${snap.totalSlices} slices verified-complete (${progressPercent(snap)}%)`);
  if (snap.lastCommit) lines.push(`- **Last verified commit:** ${snap.lastCommit.sha.slice(0, 10)} ${snap.lastCommit.message}`);
  if (snap.costUsd > 0 || snap.tokens > 0) lines.push(`- **Cost:** $${snap.costUsd.toFixed(4)} / ${snap.tokens} tokens`);
  lines.push('');

  lines.push(`## Slices`);
  lines.push('');
  lines.push(`| Slice | Title | Status | Commit | Attempts |`);
  lines.push(`| ----- | ----- | ------ | ------ | -------- |`);
  for (const id of snap.sliceOrder) {
    const s = snap.slices[id];
    if (!s) continue;
    lines.push(`| ${id} | ${s.title} | ${s.state} | ${s.lastCommit ? s.lastCommit.slice(0, 10) : '—'} | ${s.attempts} |`);
  }
  lines.push('');

  const blockedSlices = snap.sliceOrder.map((id) => snap.slices[id]).filter((s) => s && s.state === 'BLOCKED');
  if (blockedSlices.length > 0) {
    lines.push(`## Blockers`);
    lines.push('');
    if (snap.blocker) lines.push(`- ${snap.blocker.sliceId ?? ''}: ${snap.blocker.reason}`);
    lines.push(`See \`.agent-loop/reports/blocked-*.md\` for details and \`.agent-loop/artifacts/checks/\` for check output.`);
    lines.push('');
  }

  if (snap.assumptions.length > 0) {
    lines.push(`## Recorded assumptions`);
    lines.push('');
    for (const a of snap.assumptions) lines.push(`- ${a}`);
    lines.push('');
  }

  const md = session.redactor.redact(lines.join('\n') + '\n');
  const reportPath = join(session.paths.reportsDir, 'report.md');
  atomicWrite(reportPath, md);
  atomicWriteJson(join(session.paths.reportsDir, 'report.json'), {
    runId: snap.runId,
    state: snap.runState,
    goal: snap.goal || plan.goal,
    branch: snap.branch,
    verifiedCompleted: snap.verifiedCompleted,
    totalSlices: snap.totalSlices,
    progressPercent: progressPercent(snap),
    slices: snap.sliceOrder.map((id) => snap.slices[id]),
    lastCommit: snap.lastCommit ?? null,
    assumptions: snap.assumptions,
    costUsd: snap.costUsd,
    tokens: snap.tokens,
  });
  return reportPath;
}

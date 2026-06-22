/**
 * GitHub Projects (v2) Kanban sync — a robust, best-effort abstraction.
 *
 * GitHub Projects v2 vary a lot (org vs user owned, custom field names, optional
 * linkage to a repo). This module therefore:
 *  - detects a linked project + its single-select status field, and
 *  - moves an issue's card between columns,
 * but NEVER throws on the unhappy path. If anything is missing or unsupported it
 * returns a {ok:false, warning} result so the caller can log a warning and keep
 * going with labels/PRs. Mutations are gated by the client's dry-run flag.
 *
 * Limitations (documented in docs/github-triage-kanban.md):
 *  - requires `gh` with project scope (`gh auth refresh -s project`),
 *  - the status field must be a single-select named per config.github.project.statusField,
 *  - column names must match the suggested statuses (Inbox/Needs Info/Ready/…).
 */
import type { GhClient } from './client.js';
import type { GithubConfig } from '../config/config.js';
import type { ProjectStatus } from './labels.js';

export interface ProjectInfo {
  id: string;
  number: number;
  title: string;
  statusFieldId?: string;
  /** Status option name → option id. */
  options: Record<string, string>;
}

export interface ProjectSyncResult {
  ok: boolean;
  issue: number;
  status: ProjectStatus;
  dryRun: boolean;
  warning?: string;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/name, got '${repo}'`);
  return { owner, name };
}

function sanitizeFieldName(name: string): string {
  return name.replace(/["\\]/g, '');
}

/** Detect a linked Projects-v2 board + its status field. Returns undefined when
 * none is configured/available (never throws). */
export async function detectProject(client: GhClient, repo: string, cfg: GithubConfig): Promise<ProjectInfo | undefined> {
  let owner: string, name: string;
  try {
    ({ owner, name } = splitRepo(repo));
  } catch {
    return undefined;
  }
  const field = sanitizeFieldName(cfg.project.statusField);
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){projectsV2(first:20){nodes{id title number field(name:"${field}"){... on ProjectV2SingleSelectField{id options{id name}}}}}}}`;
  let data: unknown;
  try {
    data = await client.graphql(query, { owner, name });
  } catch {
    return undefined;
  }
  const nodes = pick<unknown[]>(data, ['data', 'repository', 'projectsV2', 'nodes']) ?? [];
  if (!Array.isArray(nodes) || nodes.length === 0) return undefined;
  const chosen =
    cfg.project.number !== undefined
      ? nodes.find((n) => (n as Record<string, unknown>)['number'] === cfg.project.number)
      : nodes[0];
  if (!chosen || typeof chosen !== 'object') return undefined;
  const node = chosen as Record<string, unknown>;
  const fieldObj = node['field'] as Record<string, unknown> | null;
  const options: Record<string, string> = {};
  if (fieldObj && Array.isArray(fieldObj['options'])) {
    for (const o of fieldObj['options'] as unknown[]) {
      const opt = o as Record<string, unknown>;
      if (typeof opt['name'] === 'string' && typeof opt['id'] === 'string') options[opt['name']] = opt['id'];
    }
  }
  return {
    id: String(node['id'] ?? ''),
    number: typeof node['number'] === 'number' ? (node['number'] as number) : 0,
    title: typeof node['title'] === 'string' ? (node['title'] as string) : '',
    ...(fieldObj && typeof fieldObj['id'] === 'string' ? { statusFieldId: fieldObj['id'] as string } : {}),
    options,
  };
}

/** Find the project item id for an issue (undefined if the issue isn't on the board). */
export async function findItemId(client: GhClient, repo: string, project: ProjectInfo, issue: number): Promise<string | undefined> {
  let owner: string, name: string;
  try {
    ({ owner, name } = splitRepo(repo));
  } catch {
    return undefined;
  }
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){projectItems(first:20){nodes{id project{id}}}}}}`;
  let data: unknown;
  try {
    data = await client.graphql(query, { owner, name, number: issue });
  } catch {
    return undefined;
  }
  const nodes = pick<unknown[]>(data, ['data', 'repository', 'issue', 'projectItems', 'nodes']) ?? [];
  if (!Array.isArray(nodes)) return undefined;
  for (const n of nodes) {
    const item = n as Record<string, unknown>;
    const proj = item['project'] as Record<string, unknown> | undefined;
    if (proj && proj['id'] === project.id && typeof item['id'] === 'string') return item['id'];
  }
  return undefined;
}

/** Move an issue's card to a column. Never throws; returns a result with a warning
 * when the board/field/option/item is unavailable. Mutation is gated by dry-run. */
export async function syncIssueStatus(
  client: GhClient,
  repo: string,
  cfg: GithubConfig,
  issue: number,
  status: ProjectStatus,
): Promise<ProjectSyncResult> {
  const base = { issue, status, dryRun: client.isDryRun };
  if (!cfg.project.enabled) {
    return { ...base, ok: false, warning: 'project sync disabled (config.github.project.enabled=false)' };
  }
  const project = await detectProject(client, repo, cfg);
  if (!project) return { ...base, ok: false, warning: 'no linked GitHub Project (v2) detected — skipping board sync' };
  if (!project.statusFieldId) {
    return { ...base, ok: false, warning: `project has no single-select field '${cfg.project.statusField}'` };
  }
  const optionId = project.options[status];
  if (!optionId) {
    return { ...base, ok: false, warning: `project has no '${status}' option in '${cfg.project.statusField}'` };
  }
  const itemId = await findItemId(client, repo, project, issue);
  if (!itemId) return { ...base, ok: false, warning: `issue #${issue} is not on project '${project.title}'` };

  const mutation = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`;
  try {
    await client.graphqlWrite(
      mutation,
      { project: project.id, item: itemId, field: project.statusFieldId, option: optionId },
      `#${issue} → ${status} on '${project.title}'`,
    );
    return { ...base, ok: true };
  } catch (err) {
    return { ...base, ok: false, warning: `project mutation failed: ${(err as Error).message}` };
  }
}

function pick<T>(obj: unknown, path: string[]): T | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur as T;
}

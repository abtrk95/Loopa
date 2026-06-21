/**
 * `agent-loop init` — scaffold `.agent-loop/` (config + layout) and add the local
 * git-ignore entry. Safe to re-run; never overwrites an existing config.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, ensureLayout } from '../../util/paths.js';
import { atomicWrite } from '../../util/fs.js';
import { ensureRepoIgnoresAgentDir } from '../../orchestrator/run.js';
import { resolveRoot, type ParsedArgs } from '../args.js';

const EXAMPLE_CONFIG = `# agent-loop configuration. All fields are optional; defaults shown.
# Zero-config uses the deterministic 'fake' provider (no credentials needed).
version: 1
auto: false

roles:
  planner:
    provider: fake        # e.g. claude, codex, opencode
    # model: "<your-model-id>"
  workers:
    - provider: fake
      weight: 1
  # reviewer:
  #   provider: claude
  #   model: "<your-model-id>"
  fixer:
    strategy: same-as-worker

routing:
  workerStrategy: round-robin   # static | round-robin | weighted | capability
  fallbackOrder: []
  switchProviderOnRetry: false
  reviewerConsensus: 1

execution:
  concurrency: 1
  maxRetriesPerSlice: 2
  retryBackoffMs: 2000
  agentTimeoutMs: 600000
  checkTimeoutMs: 300000

git:
  branchPrefix: "agent-loop/"
  requireCleanTree: true
  allowDirty: false

verification:
  # commands: []           # auto-detected from your project if empty
  maxDiffLines: 800
  detectTestWeakening: true
  detectSecrets: true

tui:
  color: true
  refreshMs: 1000

github:
  enabled: false
  remote: origin
  draftPr: true

# Real providers may need explicit opt-in flags to edit files autonomously.
# These are NOT added by default (safety). Example:
# providers:
#   claude:
#     args: ["--permission-mode", "acceptEdits"]
#   codex:
#     args: ["--full-auto"]
`;

export function cmdInit(args: ParsedArgs): number {
  const root = resolveRoot(args);
  const paths = projectPaths(root);
  ensureLayout(paths);
  ensureRepoIgnoresAgentDir(root);

  if (!existsSync(paths.configYml)) {
    atomicWrite(paths.configYml, EXAMPLE_CONFIG);
    process.stdout.write(`Wrote ${paths.configYml}\n`);
  } else {
    process.stdout.write(`Config already exists at ${paths.configYml} (left unchanged)\n`);
  }

  // Also add a tracked .gitignore entry for convenience.
  const gi = join(root, '.gitignore');
  const want = '.agent-loop/';
  let content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!content.split('\n').some((l) => l.trim() === want)) {
    content = content.length === 0 ? `${want}\n` : content.endsWith('\n') ? `${content}${want}\n` : `${content}\n${want}\n`;
    writeFileSync(gi, content);
    process.stdout.write(`Added '${want}' to .gitignore\n`);
  }

  process.stdout.write(
    [
      '',
      'Initialized agent-loop. Next steps:',
      '  agent-loop plan --idea "Build X"      # or --prd ./requirements.md',
      '  agent-loop run --auto                  # execute the plan',
      '  agent-loop watch                       # live dashboard (another terminal)',
      '  agent-loop demo                        # deterministic demo, no API keys',
      '',
      "If `agent-loop` is not on your PATH, run it via `npm link` (then `agent-loop ...`),",
      'or invoke it directly: `node dist/bin/agent-loop.js <cmd>` / `npm run agent-loop -- <cmd>`.',
      'Note: the default `fake` provider only succeeds inside `demo`. To run a real --idea',
      'plan to completion, configure a provider (claude/codex/opencode) in .agent-loop/config.yml.',
      '',
    ].join('\n'),
  );
  return 0;
}

/**
 * Real-provider smoke harness (T1).
 *
 * ALWAYS-ON (hermetic): argv-recording stubs prove the EXACT command + model-flag
 * construction for the claude / codex / opencode presets, the prompt-delivery
 * convention (stdin vs arg), and that NO permission-bypass flags are added by
 * default. No network, no credentials, no paid sessions.
 *
 * OPT-IN (real CLIs): version/health probes per provider, gated on explicit env
 * vars so they never run by default or in CI:
 *   AGENT_LOOP_SMOKE_CLAUDE=1     # `claude --version` is detectable + healthy
 *   AGENT_LOOP_SMOKE_CODEX=1      # `codex --version` …
 *   AGENT_LOOP_SMOKE_OPENCODE=1   # `opencode --version` …
 * And a (token-spending) end-to-end coding smoke, double-gated:
 *   AGENT_LOOP_SMOKE_LIVE=1 AGENT_LOOP_SMOKE_LIVE_PROVIDER=claude|codex|opencode
 * See docs/provider-adapters.md → "Real-provider smoke tests" for full setup.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandProvider, presetSpec } from '../../src/providers/command.js';
import { createRegistry } from '../../src/providers/registry.js';
import { ConfigSchema } from '../../src/config/config.js';
import { tempRepo, writeFakeScript, cleanupRepos } from '../helpers.js';
import { openSession, loadRunMeta } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';

const stubDirs: string[] = [];
afterAll(() => {
  for (const d of stubDirs) rmSync(d, { recursive: true, force: true });
  cleanupRepos();
});

/** A stub that records its argv + stdin next to itself, then exits 0. */
function recordingStub(): { file: string; dir: string; argv: () => string[]; stdin: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'al-prov-stub-'));
  stubDirs.push(dir);
  const file = join(dir, 'cli');
  writeFileSync(
    file,
    `#!/bin/sh\nd=$(dirname "$0")\nprintf '%s\\n' "$@" > "$d/argv.txt"\ncat > "$d/stdin.txt"\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return {
    file,
    dir,
    argv: () => (existsSync(join(dir, 'argv.txt')) ? readFileSync(join(dir, 'argv.txt'), 'utf8').replace(/\n$/, '').split('\n') : []),
    stdin: () => (existsSync(join(dir, 'stdin.txt')) ? readFileSync(join(dir, 'stdin.txt'), 'utf8') : ''),
  };
}

const DANGER_FLAGS = ['--dangerously-skip-permissions', '--yolo', '--full-auto', '--no-sandbox', 'acceptEdits', '--auto-approve'];

interface ExpectedShape {
  /** argv (excluding the prompt arg) the preset must produce for `model`. */
  baseAndModel: string[];
  delivery: 'stdin' | 'arg';
}

const EXPECTED: Record<string, ExpectedShape> = {
  claude: { baseAndModel: ['-p', '--model', 'MODEL'], delivery: 'stdin' },
  codex: { baseAndModel: ['exec', '-m', 'MODEL'], delivery: 'arg' },
  opencode: { baseAndModel: ['run', '-m', 'MODEL'], delivery: 'arg' },
};

describe('hermetic provider command construction (argv-recording stubs)', () => {
  for (const id of ['claude', 'codex', 'opencode'] as const) {
    it(`builds the correct argv + model flag + prompt delivery for ${id}`, async () => {
      const rec = recordingStub();
      const model = `MODEL-${id}`;
      const spec = { ...presetSpec(id)!, file: rec.file };
      const provider = new CommandProvider(spec);
      const pack = `CONTEXT-PACK-${id}-payload`;
      const res = await provider.execute({ role: 'worker', contextPack: pack, cwd: rec.dir, model, timeoutMs: 10_000 });
      expect(res.ok).toBe(true);

      const argv = rec.argv();
      const exp = EXPECTED[id]!;
      const wantBaseModel = exp.baseAndModel.map((a) => a.replace('MODEL', model));
      // The model id reaches the child argv via the documented flag.
      expect(argv.slice(0, wantBaseModel.length)).toEqual(wantBaseModel);

      if (exp.delivery === 'arg') {
        expect(argv).toContain(pack); // prompt delivered as a CLI arg
        expect(rec.stdin()).toBe(''); // and NOT on stdin
      } else {
        expect(rec.stdin()).toContain(pack); // prompt delivered on stdin
        expect(argv).not.toContain(pack); // and NOT as an arg
      }

      // Secure-by-default: no permission-bypass / sandbox-escape flags.
      for (const danger of DANGER_FLAGS) expect(argv).not.toContain(danger);
    });
  }

  it('honors providers.<id> config overrides through the registry (file + extra args)', async () => {
    const rec = recordingStub();
    const config = ConfigSchema.parse({
      roles: { workers: [{ provider: 'claude', model: 'cfg-model' }] },
      providers: { claude: { file: rec.file, args: ['--extra-flag'] } },
    });
    const registry = createRegistry(config, rec.dir);
    const provider = registry.get('claude');
    await provider.execute({ role: 'worker', contextPack: 'PACK', cwd: rec.dir, model: 'cfg-model', timeoutMs: 10_000 });
    const argv = rec.argv();
    expect(argv.slice(0, 3)).toEqual(['-p', '--model', 'cfg-model']);
    expect(argv).toContain('--extra-flag'); // user opt-in extra arg applied
  });
});

// ---- OPT-IN real-CLI probes (version/health only; no tokens spent) ----
const SMOKE: Record<string, string> = {
  claude: 'AGENT_LOOP_SMOKE_CLAUDE',
  codex: 'AGENT_LOOP_SMOKE_CODEX',
  opencode: 'AGENT_LOOP_SMOKE_OPENCODE',
};
for (const [id, envVar] of Object.entries(SMOKE)) {
  const enabled = process.env[envVar] === '1';
  describe.skipIf(!enabled)(`real provider ${id} [opt-in: ${envVar}=1]`, () => {
    it('detects a version and reports healthy', async () => {
      const provider = new CommandProvider(presetSpec(id)!);
      const version = await provider.detectVersion();
      expect(version, `${id} --version returned null (is it installed + on PATH?)`).toBeTruthy();
      expect((await provider.health()).ok).toBe(true);
    }, 30_000);
  });
}

// ---- OPT-IN live coding smoke (SPENDS REAL TOKENS; double-gated) ----
const liveProvider = process.env['AGENT_LOOP_SMOKE_LIVE'] === '1' ? process.env['AGENT_LOOP_SMOKE_LIVE_PROVIDER'] : undefined;
describe.skipIf(!liveProvider)(`live coding smoke [opt-in: AGENT_LOOP_SMOKE_LIVE=1]`, () => {
  it(`drives a real ${liveProvider} session against a throwaway repo`, async () => {
    const root = tempRepo();
    // No fake script — the real provider must actually run.
    writeFakeScript(root, { slices: {}, reviews: {} });
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        roles: { workers: [{ provider: liveProvider! }] },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0, agentTimeoutMs: 180_000 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, {
        input: { kind: 'prd-json', text: JSON.stringify({ description: 'smoke', userStories: [{ id: 'U', title: 'Create greeting', description: 'Create src/hello.js exporting hello()', acceptanceCriteria: ['src/hello.js exports hello'], allowedPaths: ['src/**'] }] }) },
        auto: true,
      });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      // We don't assert success (a real model may or may not satisfy the slice);
      // we assert the real provider was actually spawned and the run terminated.
      expect(['COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED']).toContain(result.finalState);
      const events = session.store.read(runId);
      expect(events.some((e) => e.type === 'PROVIDER_SELECTED' && e.payload['provider'] === liveProvider)).toBe(true);
      expect(events.some((e) => e.type === 'AGENT_PROCESS_EXITED')).toBe(true);
    } finally {
      session.close();
    }
  }, 240_000);
});

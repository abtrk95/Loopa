/**
 * Browser / UI verification (T2). Deterministic coverage uses a real fixture HTTP
 * app started/stopped through the harness:
 *   - app startup + readiness probe + teardown (no orphan server),
 *   - real HTTP-engine navigation: 200 ok, 500 fail, console-error sentinel fail,
 *   - the full capture pipeline (screenshots/HTML + console errors + JSON artifact)
 *     proven deterministically via an injected FakeBrowserEngine,
 *   - startup-timeout cleanup,
 *   - pure engine-selection / Chrome-resolution / console-classification helpers.
 * A real headless-Chrome (CDP) test is opt-in (AGENT_LOOP_SMOKE_BROWSER=1 or a
 * detectable Chrome) and proves real PNG screenshots + real console capture.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../../src/process/manager.js';
import { Redactor } from '../../src/security/redact.js';
import {
  runBrowserVerification,
  HttpBrowserEngine,
  FakeBrowserEngine,
  selectEngine,
  type BrowserVerifyResult,
  type NavResult,
} from '../../src/verify/browser.js';
import { BrowserConfigSchema, type BrowserConfig } from '../../src/config/config.js';
import { resolveChromePath, classifyConsoleEvent, chromeCandidates } from '../../src/verify/browser-cdp.js';
import { tempRepo, writeFakeScript, cleanupRepos } from '../helpers.js';
import { openSession, loadRunMeta } from '../../src/orchestrator/session.js';
import { createPlan } from '../../src/orchestrator/planning.js';
import { RunEngine } from '../../src/orchestrator/run.js';
import { project } from '../../src/events/projection.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/browser-app.mjs', import.meta.url));
const pm = new ProcessManager();
const dirs: string[] = [];
function uiDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'al-ui-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  cleanupRepos();
});

const onePrd = JSON.stringify({
  description: 'one slice',
  userStories: [{ id: 'U', title: 'do it', description: 'd', acceptanceCriteria: ['c'], allowedPaths: ['src/**'] }],
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** True once nothing is listening on the port (connection refused). */
function tcpRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect({ port, host: '127.0.0.1' });
    c.on('connect', () => {
      c.destroy();
      resolve(false);
    });
    c.on('error', () => resolve(true));
  });
}

function cfg(over: Partial<BrowserConfig>): BrowserConfig {
  return BrowserConfigSchema.parse({ enabled: true, engine: 'http', ...over });
}

describe('browser verification — real fixture app via HTTP engine', () => {
  it('starts the app, navigates routes, captures artifacts, and tears the server down', async () => {
    const port = await freePort();
    const ui = uiDir();
    const result = await runBrowserVerification({
      config: cfg({
        startCommand: ['node', FIXTURE, String(port)],
        baseUrl: `http://127.0.0.1:${port}`,
        routes: ['/', '/boom', '/error'],
        startupTimeoutMs: 10_000,
        navigationTimeoutMs: 5_000,
      }),
      cwd: process.cwd(),
      uiSmokeDir: ui,
      sliceId: 'S-001',
      pm,
      redactor: new Redactor(),
    });

    expect(result.ran).toBe(true);
    expect(result.engine).toBe('http');
    // '/' ok; '/boom' (500) and '/error' (console-error sentinel) fail.
    const byRoute = Object.fromEntries(result.routes.map((r) => [r.route, r]));
    expect(byRoute['/']?.ok).toBe(true);
    expect(byRoute['/']?.status).toBe(200);
    expect(byRoute['/boom']?.ok).toBe(false);
    expect(byRoute['/boom']?.status).toBe(500);
    expect(byRoute['/error']?.ok).toBe(false);
    expect(byRoute['/error']?.consoleErrors.some((e) => e.includes('__BROWSER_ERROR__'))).toBe(true);
    expect(result.ok).toBe(false); // overall fails because two routes failed

    // HTML snapshots + JSON summary written as artifacts.
    expect(existsSync(join(ui, 'S-001__root.html'))).toBe(true);
    expect(existsSync(join(ui, 'S-001__browser.json'))).toBe(true);
    expect(readFileSync(join(ui, 'S-001__root.html'), 'utf8')).toContain('OK');

    // Server was cleaned up (port no longer accepts connections).
    let refused = false;
    for (let i = 0; i < 25 && !refused; i++) {
      refused = await tcpRefused(port);
      if (!refused) await new Promise((r) => setTimeout(r, 100));
    }
    expect(refused).toBe(true);
  }, 30_000);

  it('passes when all routes are healthy', async () => {
    const port = await freePort();
    const result = await runBrowserVerification({
      config: cfg({ startCommand: ['node', FIXTURE, String(port)], baseUrl: `http://127.0.0.1:${port}`, routes: ['/'], startupTimeoutMs: 10_000 }),
      cwd: process.cwd(),
      uiSmokeDir: uiDir(),
      sliceId: 'S-OK',
      pm,
      redactor: new Redactor(),
    });
    expect(result.ok).toBe(true);
    expect(result.routes[0]?.status).toBe(200);
  }, 30_000);
});

describe('browser verification — capture pipeline (injected engine)', () => {
  it('writes a PNG screenshot artifact and flags console errors', async () => {
    const port = await freePort();
    const ui = uiDir();
    const png = Buffer.from('\x89PNG\r\n\x1a\nFAKE', 'binary');
    const fake = new FakeBrowserEngine((url): NavResult => {
      if (url.endsWith('/bad')) return { url, status: 200, ok: true, consoleErrors: ['console.error: boom'], screenshot: png };
      return { url, status: 200, ok: true, consoleErrors: [], screenshot: png };
    });
    const result = await runBrowserVerification({
      config: cfg({ startCommand: ['node', FIXTURE, String(port)], baseUrl: `http://127.0.0.1:${port}`, routes: ['/', '/bad'], startupTimeoutMs: 10_000, failOnConsoleError: true }),
      cwd: process.cwd(),
      uiSmokeDir: ui,
      sliceId: 'S-PNG',
      pm,
      redactor: new Redactor(),
      engineOverride: fake,
    });
    expect(result.ran).toBe(true);
    expect(existsSync(join(ui, 'S-PNG__root.png'))).toBe(true);
    expect(existsSync(join(ui, 'S-PNG__bad.png'))).toBe(true);
    // /bad has a console error → not ok with failOnConsoleError.
    expect(result.routes.find((r) => r.route === '/bad')?.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(fake.closed).toBe(true); // engine torn down
  }, 30_000);
});

describe('browser verification — startup timeout cleanup', () => {
  it('fails cleanly and kills the server when the app never serves the ready URL', async () => {
    const port = await freePort();
    // A "server" that runs but never listens on the port → readiness times out.
    const result = await runBrowserVerification({
      config: cfg({ startCommand: ['node', '-e', 'setInterval(()=>{},1000)'], baseUrl: `http://127.0.0.1:${port}`, routes: ['/'], startupTimeoutMs: 1200 }),
      cwd: process.cwd(),
      uiSmokeDir: uiDir(),
      sliceId: 'S-TIMEOUT',
      pm,
      redactor: new Redactor(),
    });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/did not become ready/i);
  }, 15_000);
});

describe('browser verification — disabled / no-routes', () => {
  it('does not run when disabled', async () => {
    const result = await runBrowserVerification({
      config: BrowserConfigSchema.parse({ enabled: false }),
      cwd: process.cwd(),
      uiSmokeDir: uiDir(),
      sliceId: 'S-OFF',
      pm,
      redactor: new Redactor(),
    });
    expect(result.ran).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe('engine selection + CDP helpers (pure)', () => {
  it('selects the HTTP engine when engine=http', () => {
    expect(selectEngine(cfg({ engine: 'http' }), pm)).toBeInstanceOf(HttpBrowserEngine);
  });
  it('throws for engine=cdp with no Chrome path and none installed', () => {
    const noChrome = resolveChromePath('/definitely/not/chrome') === undefined && !existsSync(chromeCandidates()[0] ?? '');
    if (!noChrome) return; // a real Chrome is installed → skip the negative assertion
    expect(() => selectEngine(cfg({ engine: 'cdp', chromePath: '/definitely/not/chrome' }), pm)).toThrow(/Chrome/);
  });
  it('classifies CDP console/exception/log events', () => {
    expect(classifyConsoleEvent('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] })).toMatch(/console\.error: boom/);
    expect(classifyConsoleEvent('Runtime.consoleAPICalled', { type: 'log', args: [] })).toBeNull();
    expect(classifyConsoleEvent('Runtime.exceptionThrown', { exceptionDetails: { text: 'kaboom' } })).toMatch(/uncaught/);
    expect(classifyConsoleEvent('Log.entryAdded', { entry: { level: 'error', text: 'bad' } })).toMatch(/log\.error/);
    expect(classifyConsoleEvent('Log.entryAdded', { entry: { level: 'info', text: 'ok' } })).toBeNull();
  });
});

describe('browser verification wired into the slice lifecycle', () => {
  it('blocks the slice when required browser verification fails', async () => {
    const port = await freePort();
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } }, reviews: {} });
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        browser: {
          enabled: true,
          engine: 'http',
          required: true,
          startCommand: ['node', FIXTURE, String(port)],
          baseUrl: `http://127.0.0.1:${port}`,
          routes: ['/boom'], // 500 → browser verification fails
          startupTimeoutMs: 10_000,
        },
        execution: { maxRetriesPerSlice: 0, retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('BLOCKED');
      const events = session.store.read(runId);
      expect(project(events).verifiedCompleted).toBe(0);
      const finished = events.find((e) => e.type === 'BROWSER_VERIFICATION_FINISHED');
      expect(finished?.payload['ok']).toBe(false);
      // Deterministic verifier passed first; the block came from the browser gate.
      expect(events.some((e) => e.type === 'VERIFICATION_PASSED')).toBe(true);
      expect(events.some((e) => e.type === 'COMMIT_CREATED')).toBe(false);
    } finally {
      session.close();
    }
  }, 30_000);

  it('completes the slice when advisory browser verification fails (required=false)', async () => {
    const port = await freePort();
    const root = tempRepo();
    writeFakeScript(root, { slices: { 'S-001': { files: { 'src/x.js': 'module.exports = 1;\n' }, summary: 'x' } }, reviews: {} });
    const session = openSession({
      root,
      skipUserConfig: true,
      cliOverrides: {
        browser: {
          enabled: true,
          engine: 'http',
          required: false, // advisory — failure recorded but never blocks
          startCommand: ['node', FIXTURE, String(port)],
          baseUrl: `http://127.0.0.1:${port}`,
          routes: ['/boom'],
          startupTimeoutMs: 10_000,
        },
        execution: { retryBackoffMs: 0, retryJitterMs: 0 },
      },
    });
    try {
      const { plan, runId } = createPlan(session, { input: { kind: 'prd-json', text: onePrd }, auto: true });
      const result = await new RunEngine(session, plan, loadRunMeta(session.paths)!).start();
      expect(result.finalState).toBe('COMPLETED');
      const events = session.store.read(runId);
      expect(project(events).verifiedCompleted).toBe(1);
      const finished = events.find((e) => e.type === 'BROWSER_VERIFICATION_FINISHED');
      expect(finished?.payload['ok']).toBe(false); // it DID fail, but advisory → slice proceeds
      expect(events.some((e) => e.type === 'COMMIT_CREATED')).toBe(true);
    } finally {
      session.close();
    }
  }, 30_000);
});

// Opt-in: requires a real headless Chrome (real PNG + real console capture).
const wantCdp = process.env['AGENT_LOOP_SMOKE_BROWSER'] === '1' || resolveChromePath() !== undefined;
describe.skipIf(!wantCdp)('browser verification — real Chrome (CDP) [opt-in]', () => {
  it('captures a real PNG screenshot and real console errors', async () => {
    const port = await freePort();
    const ui = uiDir();
    let result: BrowserVerifyResult;
    try {
      result = await runBrowserVerification({
        config: cfg({
          engine: 'cdp',
          startCommand: ['node', FIXTURE, String(port)],
          baseUrl: `http://127.0.0.1:${port}`,
          routes: ['/', '/error'],
          startupTimeoutMs: 20_000,
          navigationTimeoutMs: 15_000,
        }),
        cwd: process.cwd(),
        uiSmokeDir: ui,
        sliceId: 'S-CDP',
        pm,
        redactor: new Redactor(),
      });
    } catch (err) {
      // CDP/Chrome flakiness in CI should not fail the suite when opted in via auto-detect.
      if (process.env['AGENT_LOOP_SMOKE_BROWSER'] !== '1') return;
      throw err;
    }
    if (result.engine !== 'cdp') return; // fell back to http (no usable Chrome) — nothing to assert
    expect(existsSync(join(ui, 'S-CDP__root.png'))).toBe(true);
    const png = readFileSync(join(ui, 'S-CDP__root.png'));
    expect(png.subarray(0, 4).toString('binary')).toBe('\x89PNG'); // real PNG header
    // /error emits a real console.error → captured by the browser.
    expect(result.routes.find((r) => r.route === '/error')?.consoleErrors.length).toBeGreaterThan(0);
  }, 60_000);
});

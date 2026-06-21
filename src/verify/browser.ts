/**
 * Browser / UI verification — a REAL, wired check for frontend slices.
 *
 * The harness:
 *  1. starts the app under test as a server (config.browser.startCommand),
 *  2. waits (with a startup timeout) for it to serve config.browser.baseUrl,
 *  3. navigates each configured route, capturing a screenshot + console errors,
 *  4. writes artifacts (screenshots/HTML snapshots + a JSON summary), and
 *  5. ALWAYS tears down the server tree + the browser engine (timeout cleanup).
 *
 * Two engines implement the same `BrowserEngine` contract:
 *  - `CdpBrowserEngine` (real headless Chrome via DevTools): real PNG screenshots
 *    and real browser console-error capture. Used when a Chrome binary is found.
 *  - `HttpBrowserEngine` (zero-dependency): real HTTP navigation against the
 *    running app, saving the served HTML as the route snapshot and flagging page
 *    errors from the HTTP status + an error sentinel. Used as the fallback.
 *
 * Browser verification is ADVISORY by default and runs only AFTER the
 * deterministic verifier has already passed — it can never turn a verifier
 * fail/block into a pass. With `browser.required = true` a browser failure blocks
 * the slice (like a failing required review), but the deterministic verifier
 * remains the sole authority over what is *eligible* to be reviewed at all.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { atomicWrite, ensureDir, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, chmodSafe } from '../util/fs.js';
import type { ProcessManager, ServerHandle } from '../process/manager.js';
import type { Redactor } from '../security/redact.js';
import type { BrowserConfig } from '../config/config.js';
import { resolveChromePath, CdpBrowserEngine } from './browser-cdp.js';

/** The outcome of navigating one route. */
export interface NavResult {
  url: string;
  status: number | null;
  ok: boolean;
  consoleErrors: string[];
  /** PNG bytes (CDP engine). */
  screenshot?: Buffer | undefined;
  /** HTML snapshot (HTTP engine). */
  html?: string | undefined;
  error?: string | undefined;
}

/** A pluggable browser engine. */
export interface BrowserEngine {
  readonly kind: 'cdp' | 'http' | 'fake';
  navigate(url: string, timeoutMs: number): Promise<NavResult>;
  close(): Promise<void>;
}

export interface BrowserVerifyRequest {
  config: BrowserConfig;
  cwd: string;
  uiSmokeDir: string;
  sliceId: string;
  pm: ProcessManager;
  redactor: Redactor;
  signal?: AbortSignal | undefined;
  /** Test seam: inject an engine (skips engine auto-selection). */
  engineOverride?: BrowserEngine;
}

export interface RouteResult {
  route: string;
  url: string;
  status: number | null;
  ok: boolean;
  consoleErrors: string[];
  artifact?: string | undefined;
  error?: string | undefined;
}

export interface BrowserVerifyResult {
  /** Did the check actually execute (false when disabled / nothing to do)? */
  ran: boolean;
  ok: boolean;
  engine: BrowserEngine['kind'] | 'none';
  summary: string;
  routes: RouteResult[];
  artifacts: string[];
}

const SENTINELS = [/__BROWSER_ERROR__[^\n]*/g, /Uncaught[^\n]*/g];

/** Zero-dependency engine: real HTTP navigation, HTML snapshots, status/sentinel errors. */
export class HttpBrowserEngine implements BrowserEngine {
  readonly kind = 'http' as const;
  async navigate(url: string, timeoutMs: number): Promise<NavResult> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      const html = await res.text();
      const consoleErrors: string[] = [];
      if (res.status >= 400) consoleErrors.push(`HTTP ${res.status}`);
      for (const re of SENTINELS) {
        for (const m of html.matchAll(re)) consoleErrors.push(m[0].slice(0, 200));
      }
      return { url, status: res.status, ok: res.status < 400, consoleErrors, html };
    } catch (err) {
      return { url, status: null, ok: false, consoleErrors: [], error: (err as Error).message };
    }
  }
  async close(): Promise<void> {
    /* nothing to tear down */
  }
}

/** Deterministic engine for tests: returns scripted navigation results. */
export class FakeBrowserEngine implements BrowserEngine {
  readonly kind = 'fake' as const;
  closed = false;
  constructor(private readonly script: (url: string) => NavResult) {}
  async navigate(url: string, _timeoutMs: number): Promise<NavResult> {
    void _timeoutMs;
    return this.script(url);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Pick the engine: real Chrome (CDP) when available, else the HTTP probe. */
export function selectEngine(config: BrowserConfig, pm: ProcessManager): BrowserEngine {
  if (config.engine === 'http') return new HttpBrowserEngine();
  const chrome = resolveChromePath(config.chromePath);
  if (config.engine === 'cdp') {
    if (!chrome) throw new Error('browser.engine is "cdp" but no Chrome/Chromium binary was found (set browser.chromePath)');
    return new CdpBrowserEngine(chrome, pm);
  }
  // auto
  return chrome ? new CdpBrowserEngine(chrome, pm) : new HttpBrowserEngine();
}

function safeName(route: string): string {
  return route.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

/** Run UI/browser verification for one slice. Always cleans up on exit. */
export async function runBrowserVerification(req: BrowserVerifyRequest): Promise<BrowserVerifyResult> {
  const { config } = req;
  if (!config.enabled) {
    return { ran: false, ok: true, engine: 'none', summary: 'browser verification disabled', routes: [], artifacts: [] };
  }
  if (config.routes.length === 0) {
    return { ran: false, ok: true, engine: 'none', summary: 'browser verification has no routes configured', routes: [], artifacts: [] };
  }

  ensureDir(req.uiSmokeDir, { mode: PRIVATE_DIR_MODE });
  const artifacts: string[] = [];
  let server: ServerHandle | undefined;
  let engine: BrowserEngine | undefined;
  const routes: RouteResult[] = [];

  try {
    // 1. Start the app server (optional — the app may already be running).
    if (config.startCommand) {
      server = req.pm.spawnServer(config.startCommand, { cwd: req.cwd, redactor: req.redactor });
    }

    // 2. Wait for readiness.
    const readyUrl = config.baseUrl.replace(/\/$/, '') + (config.readyPath ?? config.routes[0] ?? '/');
    const ready = await waitForServer(readyUrl, config.startupTimeoutMs, req.signal, server);
    if (!ready.ok) {
      return finish(false, ready.reason, 'none');
    }

    // 3. Engine + per-route navigation.
    engine = req.engineOverride ?? selectEngine(config, req.pm);
    if (engine instanceof CdpBrowserEngine) await engine.start(config.startupTimeoutMs);

    for (const route of config.routes) {
      if (req.signal?.aborted) break;
      const url = config.baseUrl.replace(/\/$/, '') + (route.startsWith('/') ? route : `/${route}`);
      const nav = await engine.navigate(url, config.navigationTimeoutMs);
      const artifact = writeRouteArtifact(req, route, nav);
      if (artifact) artifacts.push(artifact);
      const consoleFail = config.failOnConsoleError && nav.consoleErrors.length > 0;
      routes.push({
        route,
        url,
        status: nav.status,
        ok: nav.ok && !consoleFail,
        consoleErrors: nav.consoleErrors.map((e) => req.redactor.redact(e)),
        ...(artifact ? { artifact } : {}),
        ...(nav.error ? { error: req.redactor.redact(nav.error) } : {}),
      });
    }

    const ok = routes.length > 0 && routes.every((r) => r.ok);
    const failed = routes.filter((r) => !r.ok).map((r) => r.route);
    const summary = ok
      ? `browser verification passed (${routes.length} route(s), engine=${engine.kind})`
      : `browser verification failed on: ${failed.join(', ') || '(no routes navigated)'}`;
    return finish(ok, summary, engine.kind);
  } catch (err) {
    return finish(false, `browser verification error: ${req.redactor.redact((err as Error).message)}`, engine?.kind ?? 'none');
  } finally {
    // 5. Always tear down — even on timeout/abort/error.
    if (engine) await engine.close().catch(() => undefined);
    if (server) await server.stop(2000).catch(() => undefined);
  }

  function finish(ok: boolean, summary: string, engineKind: BrowserVerifyResult['engine']): BrowserVerifyResult {
    const jsonPath = join(req.uiSmokeDir, `${req.sliceId}__browser.json`);
    const report = { sliceId: req.sliceId, ok, engine: engineKind, summary, routes };
    atomicWrite(jsonPath, req.redactor.redact(JSON.stringify(report, null, 2) + '\n'), { mode: PRIVATE_FILE_MODE });
    artifacts.push(jsonPath);
    return { ran: true, ok, engine: engineKind, summary, routes, artifacts };
  }
}

function writeRouteArtifact(req: BrowserVerifyRequest, route: string, nav: NavResult): string | undefined {
  const base = `${req.sliceId}__${safeName(route)}`;
  if (nav.screenshot) {
    const p = join(req.uiSmokeDir, `${base}.png`);
    writeFileSync(p, nav.screenshot);
    chmodSafe(p, PRIVATE_FILE_MODE);
    return p;
  }
  if (nav.html !== undefined) {
    const p = join(req.uiSmokeDir, `${base}.html`);
    atomicWrite(p, req.redactor.redact(nav.html), { mode: PRIVATE_FILE_MODE });
    return p;
  }
  return undefined;
}

async function waitForServer(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  server: ServerHandle | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'aborted before app became ready' };
    if (server && !server.running()) {
      return { ok: false, reason: `app server exited before serving ${url}` };
    }
    try {
      // Any HTTP response (even an error status) means the server is accepting
      // connections — readiness, not correctness.
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ok: true };
    } catch {
      await delay(200);
    }
  }
  return { ok: false, reason: `app did not become ready at ${url} within ${timeoutMs}ms` };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

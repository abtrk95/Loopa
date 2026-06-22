/**
 * Direct harness exercising the BUILT runBrowserVerification against the fixture app.
 * Covers: CDP (real Chrome) + HTTP fallback, screenshot/HTML artifacts, console-error
 * detection, timeout cleanup (dead port), orphan-process checks, redaction.
 *
 * Usage: node harness.mjs <scenario>
 *   scenarios: cdp-pass, cdp-error, http-pass, http-error, http-boom,
 *              timeout-deadport, redact
 */
import { runBrowserVerification } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/verify/browser.js';
import { ProcessManager } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/process/manager.js';
import { Redactor } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/security/redact.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scenario = process.argv[2];
const APP = '/Users/abtrk/Dev/loop/agent-loop/reports/e2e-evidence/browser-verify/browser-app.mjs';

// Pick a deterministic-ish free-ish port per scenario (fixture binds the argv port).
const PORT = Number(process.argv[3] ?? 4747);

const pm = new ProcessManager();
const redactor = new Redactor();
const uiSmokeDir = mkdtempSync(join(tmpdir(), 'al-ui-smoke-'));

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    startCommand: ['node', APP, String(PORT)],
    baseUrl: `http://127.0.0.1:${PORT}`,
    routes: ['/'],
    startupTimeoutMs: 15000,
    navigationTimeoutMs: 10000,
    failOnConsoleError: true,
    required: false,
    engine: 'auto',
    ...overrides,
  };
}

let config;
switch (scenario) {
  case 'cdp-pass':
    config = baseConfig({ engine: 'cdp', routes: ['/'] });
    break;
  case 'cdp-error':
    config = baseConfig({ engine: 'cdp', routes: ['/', '/error'] });
    break;
  case 'cdp-boom':
    config = baseConfig({ engine: 'cdp', routes: ['/boom'] });
    break;
  case 'http-pass':
    config = baseConfig({ engine: 'http', routes: ['/'] });
    break;
  case 'http-error':
    config = baseConfig({ engine: 'http', routes: ['/error'] });
    break;
  case 'http-boom':
    config = baseConfig({ engine: 'http', routes: ['/boom'] });
    break;
  case 'timeout-deadport':
    // No startCommand: nothing ever serves this port -> readiness fails cleanly.
    config = baseConfig({ engine: 'http', startCommand: undefined, startupTimeoutMs: 3000 });
    break;
  case 'redact': {
    // Inject a fake secret via a custom redactor + a route that echoes it.
    config = baseConfig({ engine: 'http', routes: ['/error'] });
    break;
  }
  default:
    console.error('unknown scenario', scenario);
    process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), 'al-cwd-'));

// Keepalive: the verifier's internal waits are all unref'd, so a minimal harness
// can drain the event loop and exit before a dead-port readiness loop completes.
// Production keeps other handles alive; this ref'd timer simulates that so we can
// observe the real return value.
const keepalive = setInterval(() => {}, 1000);

const t0 = Date.now();
const result = await runBrowserVerification({
  config,
  cwd,
  uiSmokeDir,
  sliceId: 'S-001',
  pm,
  redactor,
});
const dt = Date.now() - t0;
clearInterval(keepalive);

console.log(JSON.stringify({
  scenario,
  port: PORT,
  durationMs: dt,
  uiSmokeDir,
  activeCount_after: pm.activeCount,
  result,
}, null, 2));

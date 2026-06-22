/**
 * Orphan/cleanup test: startCommand DOES spawn a long-running server, but it binds
 * a DIFFERENT port than baseUrl probes -> readiness times out -> the spawned server
 * MUST be killed (no orphan). We pass the server pid out so we can probe it after.
 */
import { runBrowserVerification } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/verify/browser.js';
import { ProcessManager, isProcessAlive } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/process/manager.js';
import { Redactor } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/security/redact.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Users/abtrk/Dev/loop/agent-loop/reports/e2e-evidence/browser-verify/browser-app.mjs';
const SERVE_PORT = Number(process.argv[2] ?? 4770); // where the app actually binds
const PROBE_PORT = Number(process.argv[3] ?? 4771); // where browser verify probes (never serves)

const pm = new ProcessManager();
const redactor = new Redactor();
const uiSmokeDir = mkdtempSync(join(tmpdir(), 'al-ui-smoke-'));
const cwd = mkdtempSync(join(tmpdir(), 'al-cwd-'));

const config = {
  enabled: true,
  startCommand: ['node', APP, String(SERVE_PORT)],
  baseUrl: `http://127.0.0.1:${PROBE_PORT}`, // mismatched on purpose
  routes: ['/'],
  startupTimeoutMs: 3000,
  navigationTimeoutMs: 5000,
  failOnConsoleError: true,
  required: false,
  engine: 'http',
};

const keepalive = setInterval(() => {}, 1000);
const result = await runBrowserVerification({ config, cwd, uiSmokeDir, sliceId: 'S-001', pm, redactor });
clearInterval(keepalive);

// Give cleanup a moment, then check whether anything still listens on SERVE_PORT.
await new Promise((r) => setTimeout(r, 500));

console.log(JSON.stringify({
  servePort: SERVE_PORT,
  probePort: PROBE_PORT,
  activeCount_after: pm.activeCount,
  result,
}, null, 2));

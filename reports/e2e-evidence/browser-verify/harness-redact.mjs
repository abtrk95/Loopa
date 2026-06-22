/** Redaction test for both engines against secret-app.mjs /leak route. */
import { runBrowserVerification } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/verify/browser.js';
import { ProcessManager } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/process/manager.js';
import { Redactor } from '/Users/abtrk/Dev/loop/agent-loop/dist/src/security/redact.js';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = '/Users/abtrk/Dev/loop/agent-loop/reports/e2e-evidence/browser-verify/secret-app.mjs';
const engine = process.argv[2] ?? 'http';
const PORT = Number(process.argv[3] ?? 4780);
const SECRET = 'ghp_' + 'A'.repeat(36);

const pm = new ProcessManager();
const redactor = new Redactor();
const uiSmokeDir = mkdtempSync(join(tmpdir(), 'al-ui-smoke-'));
const cwd = mkdtempSync(join(tmpdir(), 'al-cwd-'));

const config = {
  enabled: true,
  startCommand: ['node', APP, String(PORT)],
  baseUrl: `http://127.0.0.1:${PORT}`,
  routes: ['/leak'],
  startupTimeoutMs: 15000,
  navigationTimeoutMs: 10000,
  failOnConsoleError: true,
  required: false,
  engine,
};

const keepalive = setInterval(() => {}, 1000);
const result = await runBrowserVerification({ config, cwd, uiSmokeDir, sliceId: 'S-001', pm, redactor });
clearInterval(keepalive);

// Scan ALL written artifacts (json + html) for the raw secret.
const files = readdirSync(uiSmokeDir);
const leaks = [];
for (const f of files) {
  if (f.endsWith('.png')) continue; // binary screenshot, not redacted (real screenshot bytes)
  const content = readFileSync(join(uiSmokeDir, f), 'utf8');
  if (content.includes(SECRET)) leaks.push(f);
}
// Also check the in-memory result (consoleErrors) for the raw secret.
const resultStr = JSON.stringify(result);
const resultLeak = resultStr.includes(SECRET);

console.log(JSON.stringify({
  engine,
  uiSmokeDir,
  files,
  rawSecretLeakedInFiles: leaks,
  rawSecretLeakedInResult: resultLeak,
  consoleErrors: result.routes.map((r) => r.consoleErrors),
  ok: result.ok,
  summary: result.summary,
}, null, 2));

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 3000);
let demoRunning = false;

async function readPackage() {
  try {
    return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  } catch {
    return { name: 'agent-loop', version: 'unknown' };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page({ name, version }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Loopa / agent-loop — Replit demo</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #0d0f12; color: #f4f4f5; }
    main { max-width: 920px; margin: 0 auto; padding: 72px 24px; }
    .badge { display: inline-flex; border: 1px solid #334155; border-radius: 999px; padding: 8px 12px; color: #cbd5e1; font-size: 14px; }
    h1 { font-size: clamp(40px, 7vw, 80px); line-height: .95; letter-spacing: -0.06em; margin: 28px 0 20px; }
    p { color: #cbd5e1; font-size: 18px; line-height: 1.7; max-width: 760px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 34px; }
    .card { border: 1px solid #243244; background: #111827; border-radius: 20px; padding: 22px; }
    .card h2 { font-size: 17px; margin: 0 0 10px; }
    .card p { font-size: 15px; line-height: 1.55; margin: 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    pre { overflow: auto; background: #05070a; border: 1px solid #1f2937; border-radius: 16px; padding: 16px; color: #e5e7eb; }
    a.button { display: inline-flex; align-items: center; gap: 8px; margin: 22px 12px 0 0; padding: 12px 16px; border-radius: 12px; background: #f4f4f5; color: #0d0f12; text-decoration: none; font-weight: 700; }
    a.secondary { background: transparent; color: #f4f4f5; border: 1px solid #334155; }
  </style>
</head>
<body>
  <main>
    <span class="badge">${escapeHtml(name)} v${escapeHtml(version)} · Replit-ready</span>
    <h1>Autonomous coding loops with evidence as the source of truth.</h1>
    <p>Loopa / agent-loop is a local-first CLI that treats AI coding agents as workers, not authorities. Work is only considered complete after objective checks such as git state, scoped commits, tests, lint, typecheck, build, safety policy, and human review.</p>

    <a class="button" href="/demo">Run deterministic demo</a>
    <a class="button secondary" href="/health">Health endpoint</a>
    <a class="button secondary" href="https://github.com/abtrk95/Loopa">GitHub repository</a>

    <div class="cards">
      <section class="card">
        <h2>Local-first</h2>
        <p>Run state is kept locally and projected into a read-only dashboard.</p>
      </section>
      <section class="card">
        <h2>Verified completion</h2>
        <p>Agent claims do not count. Real repository evidence does.</p>
      </section>
      <section class="card">
        <h2>Provider-ready</h2>
        <p>Built for Claude Code, Codex, opencode, and deterministic fake-provider demos.</p>
      </section>
    </div>

    <h2>Try it in this Replit app</h2>
    <pre><code>npm run build
node dist/bin/agent-loop.js demo</code></pre>
  </main>
</body>
</html>`;
}

async function runDemo() {
  if (demoRunning) {
    return { status: 409, body: 'A demo run is already in progress. Refresh in a moment.\n' };
  }

  demoRunning = true;
  try {
    const { stdout, stderr } = await execFileAsync('node', ['dist/bin/agent-loop.js', 'demo'], {
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });

    return {
      status: 200,
      body: `${stdout}\n${stderr}`.trim() + '\n',
    };
  } catch (error) {
    return {
      status: 500,
      body: `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || error}`.trim() + '\n',
    };
  } finally {
    demoRunning = false;
  }
}

const pkg = await readPackage();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, project: pkg.name, version: pkg.version }));
    return;
  }

  if (url.pathname === '/demo') {
    const result = await runDemo();
    res.writeHead(result.status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(result.body);
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(pkg));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Loopa Replit demo listening on port ${port}`);
});

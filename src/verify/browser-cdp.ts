/**
 * Real headless-browser engine over the Chrome DevTools Protocol (CDP).
 *
 * Zero npm dependencies: it launches an already-installed Chrome/Chromium in
 * headless mode and drives it via Node's built-in global `WebSocket`/`fetch`.
 * This is the engine that produces REAL pixel screenshots and REAL browser
 * console-error capture. It is selected only when a Chrome binary is found
 * (config.browser.engine = 'cdp' | 'auto'); otherwise the HTTP probe engine is
 * used (see browser.ts). Anything that fails here degrades to a clear error
 * NavResult — it never throws into the verifier.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessManager, ServerHandle } from '../process/manager.js';
import type { BrowserEngine, NavResult } from './browser.js';

/** Candidate Chrome/Chromium binaries by platform (first existing wins). */
export function chromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] ?? 'C:/Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)';
    return [
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${pf86}/Google/Chrome/Application/chrome.exe`,
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/** Resolve a usable Chrome binary, honouring an explicit path / $CHROME_PATH. */
export function resolveChromePath(explicit?: string): string | undefined {
  const fromEnv = process.env['AGENT_LOOP_CHROME'] ?? process.env['CHROME_PATH'];
  for (const c of [explicit, fromEnv].filter((x): x is string => typeof x === 'string')) {
    if (existsSync(c)) return c;
  }
  for (const c of chromeCandidates()) if (existsSync(c)) return c;
  return undefined;
}

/** Classify a CDP console / log / exception event into an error string (or null). */
export function classifyConsoleEvent(method: string, params: Record<string, unknown>): string | null {
  if (method === 'Runtime.consoleAPICalled') {
    const type = params['type'];
    if (type === 'error' || type === 'assert') {
      const args = (params['args'] as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      const text = args.map((a) => String(a.description ?? a.value ?? '')).join(' ').trim();
      return `console.${type}: ${text || '(no message)'}`;
    }
    return null;
  }
  if (method === 'Runtime.exceptionThrown') {
    const ex = (params['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined) ?? {};
    return `uncaught: ${ex.exception?.description ?? ex.text ?? 'exception'}`;
  }
  if (method === 'Log.entryAdded') {
    const entry = (params['entry'] as { level?: string; text?: string } | undefined) ?? {};
    if (entry.level === 'error') return `log.error: ${entry.text ?? ''}`;
    return null;
  }
  return null;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** Minimal CDP client over a single (flattened) WebSocket. */
class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Array<(p: Record<string, unknown>) => void>>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)));
  }

  static async connect(wsUrl: string, timeoutMs: number): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    const closeQuietly = (): void => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        // Close the socket before rejecting, else the fd leaks on timeout.
        closeQuietly();
        reject(new Error('CDP websocket connect timeout'));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        closeQuietly();
        reject(new Error('CDP websocket error'));
      });
    });
    return new CdpClient(ws);
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg['id'] === 'number') {
      const p = this.pending.get(msg['id'] as number);
      if (!p) return;
      this.pending.delete(msg['id'] as number);
      if (msg['error']) p.reject(new Error(JSON.stringify(msg['error'])));
      else p.resolve((msg['result'] as Record<string, unknown>) ?? {});
      return;
    }
    const method = msg['method'] as string | undefined;
    if (method) {
      for (const cb of this.listeners.get(method) ?? []) cb((msg['params'] as Record<string, unknown>) ?? {});
    }
  }

  on(method: string, cb: (p: Record<string, unknown>) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(cb);
    this.listeners.set(method, list);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload['sessionId'] = sessionId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export class CdpBrowserEngine implements BrowserEngine {
  readonly kind = 'cdp' as const;
  private chrome: ServerHandle | undefined;
  private client: CdpClient | undefined;
  private sessionId: string | undefined;
  private userDataDir: string | undefined;
  private consoleErrors: string[] = [];
  private lastDocStatus: number | null = null;

  constructor(
    private readonly chromePath: string,
    private readonly pm: ProcessManager,
  ) {}

  /** Launch Chrome headless and attach a CDP page session. */
  async start(startupTimeoutMs: number): Promise<void> {
    this.userDataDir = mkdtempSync(join(tmpdir(), 'al-cdp-'));
    this.chrome = this.pm.spawnServer(
      [
        this.chromePath,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--remote-debugging-port=0',
        `--user-data-dir=${this.userDataDir}`,
        'about:blank',
      ],
      { cwd: this.userDataDir },
    );
    const port = await this.readDevtoolsPort(this.userDataDir, startupTimeoutMs);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    this.client = await CdpClient.connect(version.webSocketDebuggerUrl, startupTimeoutMs);
    const { targetId } = (await this.client.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await this.client.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    this.sessionId = sessionId;
    await this.client.send('Page.enable', {}, sessionId);
    await this.client.send('Runtime.enable', {}, sessionId);
    await this.client.send('Log.enable', {}, sessionId);
    await this.client.send('Network.enable', {}, sessionId);
    const collect = (method: string) => (p: Record<string, unknown>): void => {
      const e = classifyConsoleEvent(method, p);
      if (e) this.consoleErrors.push(e);
    };
    this.client.on('Runtime.consoleAPICalled', collect('Runtime.consoleAPICalled'));
    this.client.on('Runtime.exceptionThrown', collect('Runtime.exceptionThrown'));
    this.client.on('Log.entryAdded', collect('Log.entryAdded'));
    this.client.on('Network.responseReceived', (p) => {
      if (p['type'] === 'Document') {
        const resp = p['response'] as { status?: number } | undefined;
        this.lastDocStatus = resp?.status ?? null;
      }
    });
  }

  private async readDevtoolsPort(dir: string, timeoutMs: number): Promise<number> {
    const file = join(dir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const first = readFileSync(file, 'utf8').split('\n')[0]?.trim();
        const port = Number(first);
        if (Number.isFinite(port) && port > 0) return port;
      }
      if (this.chrome && !this.chrome.running()) throw new Error('Chrome exited before reporting a debugging port');
      await delay(100);
    }
    throw new Error('timed out waiting for Chrome DevTools port');
  }

  async navigate(url: string, timeoutMs: number): Promise<NavResult> {
    if (!this.client || !this.sessionId) {
      return { url, status: null, ok: false, consoleErrors: [], error: 'CDP engine not started' };
    }
    this.consoleErrors = [];
    this.lastDocStatus = null;
    try {
      const loaded = new Promise<void>((resolve) => {
        this.client!.on('Page.loadEventFired', () => resolve());
        setTimeout(resolve, timeoutMs); // proceed even if load event is missed
      });
      await this.client.send('Page.navigate', { url }, this.sessionId, timeoutMs);
      await loaded;
      await delay(150); // let trailing console/network events flush
      const shot = (await this.client.send('Page.captureScreenshot', { format: 'png' }, this.sessionId, timeoutMs)) as { data?: string };
      const screenshot = shot.data ? Buffer.from(shot.data, 'base64') : undefined;
      const status = this.lastDocStatus;
      return {
        url,
        status,
        ok: status === null ? true : status < 400,
        consoleErrors: [...this.consoleErrors],
        ...(screenshot ? { screenshot } : {}),
      };
    } catch (err) {
      return { url, status: null, ok: false, consoleErrors: [...this.consoleErrors], error: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    this.client?.close();
    if (this.chrome) await this.chrome.stop(2000).catch(() => undefined);
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

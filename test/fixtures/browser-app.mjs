/**
 * Tiny deterministic HTTP app used by the browser-verification tests. Routes:
 *   GET /        → 200, healthy HTML
 *   GET /boom    → 500, error status
 *   GET /error   → 200, but emits a real console.error AND an HTML error sentinel
 * Usage: node browser-app.mjs <port>   (port 0 → an ephemeral port, printed)
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/boom')) {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>boom</h1></body></html>');
    return;
  }
  if (url.startsWith('/error')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><html><body><h1>page</h1>' +
        '<script>console.error("__BROWSER_ERROR__ from console");</script>' +
        '__BROWSER_ERROR__ injected' +
        '</body></html>',
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><head><title>OK</title></head><body><h1>OK</h1></body></html>');
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  // eslint-disable-next-line no-console
  console.log(`LISTENING ${typeof addr === 'object' && addr ? addr.port : port}`);
});

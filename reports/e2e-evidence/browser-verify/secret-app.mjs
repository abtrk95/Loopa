/** App that leaks a secret-shaped string in HTML + console.error, to test redaction. */
import { createServer } from 'node:http';
const port = Number(process.argv[2] ?? 0);
const SECRET = 'ghp_' + 'A'.repeat(36); // GitHub PAT shape -> must be redacted
const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/leak')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><html><body><h1>leak</h1>' +
        `<script>console.error("token=${SECRET}");</script>` +
        `<p>__BROWSER_ERROR__ token=${SECRET}</p>` +
        '</body></html>',
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body><h1>OK</h1></body></html>');
});
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log(`LISTENING ${typeof addr === 'object' && addr ? addr.port : port}`);
});

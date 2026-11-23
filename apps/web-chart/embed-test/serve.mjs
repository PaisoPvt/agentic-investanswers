// Serves the embed test page (index.html beside this file) on a port, for the
// embed e2e (M2-11) and for trying an embed by hand:
//
//   node apps/web-chart/embed-test/serve.mjs 4175
//
// Only the one page; anything else is 404.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4175);
const page = readFileSync(new URL('./index.html', import.meta.url));

createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (path !== '/' && path !== '/index.html') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
}).listen(port, '127.0.0.1', () => console.log(`embed test page on http://127.0.0.1:${port}`));

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const requestedPath = pathname === '/' ? '/serene_webgl_koi_pond_simulation.html' : pathname;
  const filePath = path.resolve(root, `.${requestedPath}`);
  const relativePath = path.relative(root, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  let fileInfo;
  try {
    fileInfo = statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      response.writeHead(404).end('Not found');
      return;
    }
    console.error(`Unable to access ${filePath}:`, error);
    response.writeHead(500).end('Internal server error');
    return;
  }

  if (!fileInfo.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Length': fileInfo.size,
    'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', error => {
    console.error(`Unable to read ${filePath}:`, error);
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal server error');
  });
  stream.pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Pond running at http://localhost:${port}/serene_webgl_koi_pond_simulation.html`);
  console.log('Press Ctrl+C to stop the server.');
});

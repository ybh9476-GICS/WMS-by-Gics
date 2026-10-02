const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const host = '127.0.0.1';
const port = 4174;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function createServer(root = projectRoot) {
  const readyRoot = fs.realpath(root);
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, text) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : text);
    };
    try {
      const authority = new URL('http://' + request.headers.host);
      if (!['127.0.0.1', 'localhost'].includes(authority.hostname)) return reply(403, 'Local requests only.');
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return reply(405, 'This preview server does not write files.');
      }
      let pathname;
      try { pathname = decodeURIComponent(request.url.split('?')[0]); }
      catch { return reply(400, 'Invalid URL.'); }
      if (pathname === '/') pathname = '/index.html';
      if (pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
      const parts = pathname.split('/');
      if (parts.some(part => part.startsWith('.') || /[\\:\0]/.test(part))) return reply(403, 'Forbidden path.');
      if (pathname !== '/index.html' && !/^\/(js|css|data|vendor)\/.+\.(js|css|json)$/.test(pathname)) return reply(404, 'Not found.');
      const base = await readyRoot;
      const file = await fs.realpath(path.resolve(base, '.' + pathname));
      const relative = path.relative(base, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return reply(403, 'Forbidden path.');
      if (!(await fs.stat(file)).isFile()) return reply(404, 'Not found.');
      // Read the current file for each request: no build, copy, or server restart.
      const data = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      reply(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500, 'Could not read the requested file.');
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? 'Port 4174 is already in use. Check the existing server; no process was stopped.'
      : error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`WMS by Gics: ${url}\nFolder: ${projectRoot}\nSave code, then refresh the browser. Press Ctrl+C to stop.`);
    if (process.argv.includes('--open')) {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], { windowsHide: true }, error => {
        if (error) console.error(`Open ${url} in your browser. ${error.message}`);
      });
    }
  });
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}

module.exports = { createServer };

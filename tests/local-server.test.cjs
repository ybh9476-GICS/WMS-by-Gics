const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../scripts/local-server.cjs');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-server-test-'));
  let server;
  try {
    await fs.mkdir(path.join(root, 'js'));
    await fs.writeFile(path.join(root, 'index.html'), '<title>WMS by Gics</title>');
    await fs.writeFile(path.join(root, 'js', 'app.js'), 'const version = 1;');
    server = createServer(root);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const get = (url, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => body += chunk);
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      request.on('error', reject); request.end();
    });
    assert.equal((await get('/')).body, '<title>WMS by Gics</title>');
    assert.equal((await get('/js/app.js')).body, 'const version = 1;');
    await fs.writeFile(path.join(root, 'js', 'app.js'), 'const version = 2;');
    const updated = await get('/js/app.js?v=old');
    assert.equal(updated.body, 'const version = 2;');
    assert.equal(updated.headers['cache-control'], 'no-store');
    assert.match(updated.headers['content-type'], /javascript/);
    const head = await get('/index.html', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal((await get('/index.html', 'POST')).status, 405);
    assert.equal((await get('/index.html', 'GET', { Host: 'external.invalid' })).status, 403);
    for (const url of ['/../index.html', '/%2e%2e/index.html', '/js/..%5cindex.html', '/.git/config']) {
      assert.equal((await get(url)).status, 403, url);
    }
    for (const url of ['/scripts/local-server.cjs', '/output/report.json', '/js/missing.js']) {
      assert.equal((await get(url)).status, 404, url);
    }
    assert.equal((await get('/%ZZ')).status, 400);
    // A Windows junction must not expose files outside this project root.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gics-server-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'outside.js'), 'outside');
      await fs.symlink(outside, path.join(root, 'js', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal((await get('/js/linked/outside.js')).status, 403);
      await fs.unlink(path.join(root, 'js', 'linked'));
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
    console.log('Local server: fresh code reads, MIME, HEAD, loopback binding, write rejection and path/junction isolation passed.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { freePort } = require('../inspire');

test('Notebook binding survives editing, disk storage, and manager restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtunnel-storage-'));
  const config = path.join(dir, 'tunnels.json');
  fs.writeFileSync(config, '[]');
  const port = await freePort([]);
  const tunnelPort = await freePort([port]);
  const editedPort = await freePort([port, tunnelPort]);
  let child;
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { ...process.env, RT_SHARED_CONFIG: config, RT_DATA_DIR: dir, RT_MANAGER_PORT: String(port), RT_NO_AUTOOPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server startup timed out')), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Test server exited')); });
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('http://127.0.0.1:')) { clearTimeout(timeout); resolve(); }
      });
      child.stderr.resume();
    });
  }
  async function stop() {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  async function request(route, method = 'GET', body, expectedStatus = 200) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-RT-Client': 'test-client' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, expectedStatus);
    return res.json();
  }
  try {
    await start();
    const binding = { account: 'example-account', workspace: 'example-space', notebook: 'example-notebook' };
    const fields = { name: 'initial', url: 'https://example.invalid/jupyter/example/session/proxy/31337/', port: tunnelPort, inspire: binding };
    const created = await request('/api/tunnels', 'POST', fields);
    const id = created.tunnel.id;
    const { inspire, ...edited } = fields;
    await request('/api/tunnels/' + id, 'PUT', { ...edited, name: 'renamed', port: editedPort });
    const stored = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.deepEqual(stored[0].inspire, binding);
    await stop(); await start();
    const { tunnels } = await request('/api/tunnels');
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].id, id);
    assert.equal(tunnels[0].name, 'renamed');
    assert.equal(tunnels[0].port, editedPort);
    assert.deepEqual(tunnels[0].inspire, binding);
    const duplicate = { ...edited, name: 'old display name', port: tunnelPort };
    const rejected = await request('/api/tunnels', 'POST', duplicate, 409);
    assert.equal(rejected.code, 'DUPLICATE_NOTEBOOK_CONNECTION');
    assert.equal(rejected.existingPort, editedPort);
    // Simulate a legacy duplicate that existed before the safeguards were installed.
    fs.writeFileSync(config, JSON.stringify([...JSON.parse(fs.readFileSync(config, 'utf8')), { ...duplicate, id: 'legacy' }]));
    await request('/api/tunnels/legacy', 'PUT', duplicate, 409);
    for (const action of ['start', 'restart']) {
      const result = await request('/api/tunnels/legacy/' + action, 'POST', {}, 409);
      assert.equal(result.code, 'DUPLICATE_NOTEBOOK_CONNECTION');
      assert.equal(result.existingTunnelId, id);
    }
    const audit = fs.readFileSync(path.join(dir, 'logs', 'manager-events.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 2);
    assert.ok(audit.every(e => e.source === 'external' && e.result === 'duplicate-blocked'));
    assert.ok(audit.every(e => !('url' in e) && !('name' in e)));
    await request('/api/tunnels/legacy/stop', 'POST', {});
    await request('/api/tunnels', 'POST', { ...duplicate, url: duplicate.url.replace('/31337/', '/31338/') });
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

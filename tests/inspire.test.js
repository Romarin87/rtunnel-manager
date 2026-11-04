'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { createInspire, redact, assertPortFree, sshReady } = require('../inspire');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ state = 'RUNNING', group = 'CPU', gpuType, failRefresh = false } = {}) {
  const tunnels = [], calls = [], mutations = [];
  let url = 'https://host/secret-path/proxy/31337/?token=secret';
  const run = async args => {
    calls.push(args);
    if (args[0] === '--version') return 'inspire, version 7.1.14';
    let data = {};
    if (args[2] === 'list') data = { items: [{ name: 'box', status: state, compute_group: group, gpu_type: gpuType }] };
    if (args[2] === 'status') data = { status: 'RUNNING' };
    if (args[2] === 'connection' && failRefresh) throw new Error('failed ' + url);
    if (args[2] === 'proxy-url') data = { url };
    return JSON.stringify({ success: true, data });
  };
  const request = async (method, route, body) => {
    mutations.push([method, route, body]);
    if (route === '/api/tunnels') tunnels.push({ ...body, id: 'test', status: 'stopped' });
    else if (method === 'PUT') Object.assign(tunnels[0], body);
    else tunnels[0].status = route.endsWith('/start') ? 'running' : 'stopped';
    return { tunnel: tunnels[0] };
  };
  const service = createInspire({ managerPort: 7071, loadTunnels: () => tunnels,
    run, request, probe: async () => true, checkPort: async () => {}, wait: async () => {} });
  const body = { account: 'a', workspace: 'w', notebook: 'box', localPort: 14444 };
  async function connect() {
    const result = await service.connect(body);
    for (let i = 0; i < 20 && service.status().job.status === 'running'; i++) await tick();
    return result;
  }
  return { service, connect, body, tunnels, calls, mutations, rotate: () => { url = 'https://host/new-token/proxy/31337/'; } };
}
test('direct CLI starts stopped Notebook and checks RUNNING before refresh', async () => {
  const f = fixture({ state: 'STOPPED' }); await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.deepEqual(f.calls.map(args => args[2]), ['list', 'start', 'status', 'connection', 'proxy-url']);
  assert.ok(f.calls.every(args => args.includes('a') && args.includes('w')));
  assert.equal(f.tunnels[0].status, 'running');
  assert.ok(!JSON.stringify(f.service.status()).includes('secret'));
});
test('healthy connection is reused and rotated URL updates same entry', async () => {
  const f = fixture(); await f.connect(); f.mutations.length = 0;
  await f.connect(); assert.equal(f.mutations.length, 0);
  f.rotate(); await f.connect(); assert.equal(f.tunnels.length, 1);
  assert.deepEqual(f.mutations.map(([method, route]) => [method, route]), [
    ['POST', '/api/tunnels/test/stop'], ['PUT', '/api/tunnels/test'], ['POST', '/api/tunnels/test/start'],
  ]);
});
test('connection names use the provider namespace and listing reuses the port', async () => {
  const f = fixture(); await f.connect();
  assert.equal(f.tunnels[0].name, 'inspire:a:w:box');
  const listing = await f.service.notebooks('a', 'w');
  assert.equal(listing.notebooks[0].localPort, f.body.localPort);
  const otherAccount = await f.service.notebooks('other', 'w');
  assert.equal(otherAccount.notebooks[0].localPort, null);
});
test('restricted Notebook cannot start SSH setup or mutate tunnels', async () => {
  const f = fixture({ group: 'H200' }); await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.equal(f.calls.length, 1); assert.equal(f.mutations.length, 0);
});
test('compute group restriction remains effective with a generic GPU type', async () => {
  const f = fixture({ group: 'H200', gpuType: 'NVIDIA' });
  const listing = await f.service.notebooks('a', 'w');
  assert.equal(listing.notebooks[0].restricted, true);
  await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.equal(f.mutations.length, 0);
  assert.ok(f.calls.every(args => args[2] === 'list'));
});
test('CLI failure is redacted and a new attempt is allowed', async () => {
  const f = fixture({ failRefresh: true }); await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.ok(!f.service.status().job.error.includes('secret'));
  await f.connect(); assert.equal(f.mutations.length, 0);
});
test('parallel connections are rejected', async () => {
  let release;
  const service = createInspire({ managerPort: 7071, loadTunnels: () => [],
    checkPort: async () => {}, run: () => new Promise(resolve => { release = resolve; }) });
  const body = { account: 'a', workspace: 'w', notebook: 'box', localPort: 14444 };
  await service.connect(body); await assert.rejects(service.connect(body), /正在进行/);
  release('{"data":{"items":[]}}'); await tick();
  assert.equal(service.status().job.status, 'failed');
});
test('port conflicts and invalid input fail before CLI invocation', async () => {
  const f = fixture(); f.tunnels.push({ name: 'other', port: 14444 });
  await assert.rejects(f.connect(), /其他隧道/);
  await assert.rejects(f.service.connect({ ...f.body, localPort: 22 }), /端口/);
  assert.equal(f.calls.length, 0);
});
test('dependency version failure is actionable', async () => {
  const service = createInspire({ loadTunnels: () => [], run: async () => 'inspire, version 6.0.0' });
  await assert.rejects(service.accounts(), /7.1.14/);
});
test('occupied socket is preserved and split SSH banner recognized', async () => {
  const server = net.createServer(socket => { socket.write('SSH-'); setTimeout(() => socket.end('2.0-test\r\n'), 10); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { await assert.rejects(assertPortFree(port), /占用/); assert.equal(await sshReady(port), true); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('diagnostics redact headers and path tokens', () => {
  assert.ok(!redact('Cookie: abc\nAuthorization: def\nhttps://x/token-path').includes('abc'));
  assert.ok(!redact('https://x/token-path').includes('token-path'));
});
test('diagnostics redact quoted credentials and JSON headers', () => {
  for (const input of [
    'password="private value with spaces"',
    "secret='private value with spaces'",
    '{"Authorization":"Bearer private value"}',
    '{"Cookie":"session=private value"}',
    '{"access_token":"private value"}',
    '{"password":"private \\"quoted\\" value"}',
  ]) {
    const output = redact(input);
    assert.ok(!output.includes('private') && !output.includes('value'), output);
  }
});

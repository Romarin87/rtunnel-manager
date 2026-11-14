'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { createInspire, redact, assertPortFree, sshReady, duplicateNotebookConnection, notebookServiceKey } = require('../inspire');
const tick = () => new Promise(resolve => setImmediate(resolve));
const TEST_PORT = 49160;

test('duplicate guard ignores rotating credentials but distinguishes remote services', () => {
  const url = 'https://example.invalid/workspace/jupyter/notebook/session/proxy/31337/';
  const bound = { id: 'retained', url, port: 23456, status: 'stopped', inspire: { notebook: 'box' } };
  const duplicate = { id: 'old', url: url.replace('/session/', '/new-session/') + '?token=example', port: 34567 };
  assert.equal(duplicateNotebookConnection([bound], duplicate), bound);
  assert.equal(duplicateNotebookConnection([bound], bound), null);
  assert.equal(duplicateNotebookConnection([bound], { ...duplicate, url: url.replace('31337', '31338') }), null);
  assert.equal(notebookServiceKey('https://example.invalid/unrelated'), null);
  assert.equal(duplicateNotebookConnection([{ ...bound, inspire: null, status: 'running' }], duplicate)?.id, 'retained');
});

function fixture({ state = 'RUNNING', group = 'CPU', gpuType, failRefresh = false, onRefresh = () => {} } = {}) {
  const tunnels = [], calls = [], mutations = [];
  let url = 'https://host/workspace/jupyter/box-id/session-a/proxy/31337/?token=secret';
  const run = async args => {
    calls.push(args);
    if (args[0] === '--version') return 'inspire, version 7.1.14';
    let data = {};
    if (args[2] === 'list') data = { items: [{ name: 'box', status: state, compute_group: group, gpu_type: gpuType }] };
    if (args[2] === 'status') data = { status: 'RUNNING' };
    if (args[2] === 'connection' && failRefresh) throw new Error('failed ' + url);
    if (args[2] === 'connection') onRefresh(tunnels);
    if (args[2] === 'proxy-url') data = { url };
    return JSON.stringify({ success: true, data });
  };
  const request = async (method, route, body) => {
    mutations.push([method, route, body]);
    if (route === '/api/tunnels') tunnels.push({ ...body, id: 'test', status: 'stopped' });
    const target = route === '/api/tunnels' ? tunnels.at(-1) : tunnels.find(t => route.split('/')[3] === t.id);
    if (method === 'PUT') Object.assign(target, body);
    else if (route !== '/api/tunnels') target.status = route.endsWith('/start') ? 'running' : 'stopped';
    return { tunnel: target };
  };
  const service = createInspire({ managerPort: 7071, loadTunnels: () => tunnels,
    run, request, probe: async () => true, checkPort: async () => {}, wait: async () => {} });
  const body = { account: 'a', workspace: 'w', notebook: 'box', localPort: TEST_PORT };
  async function connect() {
    const result = await service.connect(body);
    for (let i = 0; i < 20 && service.status().job.status === 'running'; i++) await tick();
    return result;
  }
  return { service, connect, body, tunnels, calls, mutations, rotate: () => { url = 'https://host/workspace/jupyter/box-id/session-b/proxy/31337/'; } };
}
test('direct CLI starts stopped Notebook and checks RUNNING before refresh', async () => {
  const f = fixture({ state: 'STOPPED' }); f.body.allowStart = true; await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.deepEqual(f.calls.map(args => args[2]), ['list', 'start', 'status', 'proxy-url', 'connection', 'proxy-url']);
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
  const body = { account: 'a', workspace: 'w', notebook: 'box', localPort: TEST_PORT };
  await service.connect(body); await assert.rejects(service.connect(body), /正在进行/);
  release('{"data":{"items":[]}}'); await tick();
  assert.equal(service.status().job.status, 'failed');
});
test('port conflicts fail before remote setup and invalid input before CLI invocation', async () => {
  const f = fixture(); f.tunnels.push({ id: 'other', name: 'other', port: TEST_PORT, status: 'running' });
  await assert.rejects(f.service.connect({ ...f.body, localPort: 22 }), /端口/);
  assert.equal(f.calls.length, 0);
  await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.match(f.service.status().job.error, /其他运行中的隧道/);
  assert.ok(!f.calls.some(args => args[2] === 'connection'));
  assert.equal(f.mutations.length, 0);
});

test('stopped Notebook never starts without explicit boolean consent', async () => {
  for (const consent of [undefined, false, 'true', 1]) {
    const f = fixture({ state: 'STOPPED' }); f.body.allowStart = consent;
    await f.connect();
    assert.equal(f.service.status().job.status, 'failed');
    assert.match(f.service.status().job.error, /确认/);
    assert.deepEqual(f.calls.map(args => args[2]), ['list']);
    assert.equal(f.mutations.length, 0);
  }
});

test('renaming and changing the local port preserve Notebook identity and settings', async () => {
  const f = fixture(); await f.connect();
  Object.assign(f.tunnels[0], { name: 'custom connection', port: 23456, user: 'custom-user', args: '--secure', monitorType: 'cpu' });
  f.body.localPort = ''; f.mutations.length = 0; f.calls.length = 0;
  await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.equal(f.service.status().job.localPort, 23456);
  assert.equal(f.tunnels.length, 1);
  assert.equal(f.mutations.length, 0);
  f.rotate(); await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.equal(f.tunnels[0].name, 'custom connection');
  assert.equal(f.tunnels[0].port, 23456);
  assert.equal(f.tunnels[0].user, 'custom-user');
  assert.equal(f.tunnels[0].args, '--secure');
  assert.equal(f.tunnels[0].monitorType, 'cpu');
  assert.ok(!f.calls.some(args => args[2] === 'start'));
});

test('legacy renamed connection is identified by Notebook URL and gains binding', async () => {
  const f = fixture(); await f.connect();
  delete f.tunnels[0].inspire;
  f.tunnels[0].name = 'custom legacy'; f.tunnels[0].port = 23456;
  f.body.localPort = ''; f.mutations.length = 0;
  await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.equal(f.tunnels.length, 1);
  assert.equal(f.tunnels[0].port, 23456);
  assert.equal(f.tunnels[0].name, 'custom legacy');
  assert.deepEqual(f.tunnels[0].inspire, { account: 'a', workspace: 'w', notebook: 'box' });
  assert.deepEqual(f.mutations.map(m => m[0]), ['PUT']);
});

test('ambiguous legacy duplicates require explicit selection and keep the chosen port', async () => {
  const f = fixture(); await f.connect(); delete f.tunnels[0].inspire;
  f.tunnels.push({ ...f.tunnels[0], id: 'chosen', name: 'custom', port: 23456 });
  f.body.localPort = ''; f.mutations.length = 0;
  await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.match(f.service.status().job.error, /多条/);
  assert.equal(f.mutations.length, 0);
  f.body.tunnelId = 'chosen'; await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.equal(f.service.status().job.localPort, 23456);
  assert.equal(f.tunnels.length, 2);
  assert.deepEqual(f.mutations.map(m => m.slice(0, 2)), [['PUT', '/api/tunnels/chosen']]);
  delete f.body.tunnelId; await f.connect();
  assert.equal(f.service.status().job.localPort, 23456);
});

test('a legacy connection to a different service on the same Notebook is not adopted', async () => {
  const f = fixture();
  f.tunnels.push({ id: 'web', name: 'web service', port: 49161, status: 'running',
    url: 'https://host/workspace/jupyter/box-id/session-a/proxy/8080/' });
  await f.connect();
  assert.equal(f.service.status().job.status, 'succeeded');
  assert.equal(f.tunnels.length, 2);
  assert.equal(f.tunnels[0].inspire, undefined);
  assert.equal(f.tunnels[0].port, 49161);
  assert.equal(f.tunnels[1].monitorType, 'cpu');
});

test('a stale port selection cannot revert an edit', async () => {
  const f = fixture(); await f.connect(); f.tunnels[0].port = 23456;
  f.body.expectedPort = TEST_PORT; f.calls.length = 0;
  await assert.rejects(f.connect(), /端口已变化/);
  assert.equal(f.calls.length, 0);
});

test('an edit during remote preparation aborts without overwriting the connection', async () => {
  let edit = false;
  const f = fixture({ onRefresh: tunnels => { if (edit) tunnels[0].port = 23456; } });
  await f.connect(); edit = true; f.mutations.length = 0;
  await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.match(f.service.status().job.error, /配置已变化/);
  assert.equal(f.tunnels[0].port, 23456);
  assert.equal(f.mutations.length, 0);
});

test('selecting a different Notebook tunnel fails before any remote setup', async () => {
  const f = fixture(); f.tunnels.push({ id: 'other', url: 'https://host/workspace/jupyter/other/session/proxy/31337/', name: 'other', port: 23456 });
  f.body.tunnelId = 'other'; await f.connect();
  assert.equal(f.service.status().job.status, 'failed');
  assert.match(f.service.status().job.error, /不属于/);
  assert.ok(!f.calls.some(args => args[2] === 'connection'));
  assert.equal(f.mutations.length, 0);
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

'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { runCLI, redact } = require('./inspire-cli');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function label(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\x00-\x1f]/.test(value)) {
    throw new Error('无效的' + field);
  }
  return value.trim();
}

function restrictedNotebook(row) {
  return /H100|H200/i.test([row.gpu_type, row.compute_group].filter(Boolean).join(' '));
}

function normalizeBinding(value) {
  if (value == null) return null;
  return { account: label(value.account, '账号'), workspace: label(value.workspace, '工作空间'), notebook: label(value.notebook, 'Notebook') };
}

function sameBinding(a, b) {
  return !!a && !!b && ['account', 'workspace', 'notebook'].every(key => a[key] === b[key]);
}

// Session tokens and service ports can rotate while the Notebook stays the same.
function notebookEndpoint(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(.*)\/(?:jupyter|vscode)\/([^/]+)\//);
    return match ? url.host + match[1] + '/' + match[2] : url.origin + url.pathname;
  } catch (_) { return null; }
}

function notebookServiceKey(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^(.*)\/(?:jupyter|vscode)\/([^/]+)\/[^/]+\/proxy\/(\d+)(?:\/|$)/);
    return match ? JSON.stringify([url.host, match[1], match[2], Number(match[3])]) : null;
  } catch (_) { return null; }
}

function duplicateNotebookConnection(tunnels, target) {
  const key = notebookServiceKey(target.url);
  if (!key) return null;
  return tunnels.find(t => t.id !== target.id && notebookServiceKey(t.url) === key &&
    (t.inspire || (!target.inspire && t.status === 'running'))) || null;
}

function findConnection(tunnels, binding, url, selectedId) {
  const endpoint = notebookEndpoint(url);
  const service = notebookServiceKey(url);
  const matches = tunnels.filter(t => sameBinding(t.inspire, binding) ||
    (!t.inspire && service && notebookServiceKey(t.url) === service));
  if (endpoint && matches.some(t => sameBinding(t.inspire, binding) && notebookEndpoint(t.url) !== endpoint)) {
    throw new Error('Notebook 标识已变化，请检查关联的机器后重试');
  }
  if (selectedId) {
    const selected = matches.find(t => t.id === selectedId);
    if (!selected) throw new Error('所选本地连接不属于此 Notebook，或配置已变化，请刷新后重试');
    if (matches.some(t => t.id !== selectedId && sameBinding(t.inspire, binding))) throw new Error('此 Notebook 已关联其他连接，请先整理重复记录');
    return selected;
  }
  const bound = matches.filter(t => sameBinding(t.inspire, binding));
  if (bound.length === 1) return bound[0];
  if (matches.length > 1) throw new Error('此 Notebook 对应多条本地连接，请在“已有本地连接”中选择要复用的一条');
  return matches[0];
}

function createInspire({ managerPort, loadTunnels, run = runCLI,
  request = (method, route, body) => managerRequest(managerPort, method, route, body),
  probe = sshReady, checkPort = assertPortFree, wait = sleep }) {
  let job = null;
  let starting = false;
  async function cli(args, timeout = 120000) {
    const output = await run(['--json', ...args], timeout);
    let result;
    try { result = JSON.parse(output); } catch (_) { throw new Error('Inspire CLI 返回了无效数据'); }
    if (!result || typeof result !== 'object' || result.success === false) throw new Error(redact(result?.error?.message || 'Inspire 查询失败'));
    return result.data || result;
  }
  async function accounts() {
    const version = await run(['--version'], 15000);
    const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match || (Number(match[1]) < 7 || (Number(match[1]) === 7 &&
      (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 14))))) {
      throw new Error('需要 Inspire CLI 7.1.14 或更新版本，请更新 inspire-skill');
    }
    const data = await cli(['account', 'list']);
    return { accounts: (data.items || []).map(a => ({ name: a.name, active: !!a.active })) };
  }
  async function workspaces(account) {
    const data = await cli(['account', 'context', '--all', '--account', label(account, '账号')]);
    return { workspaces: data.workspaces || [] };
  }
  async function notebooks(account, workspace) {
    const data = await cli(['notebook', 'list', '--all', '--account', label(account, '账号'), '--workspace', label(workspace, '工作空间')]);
    const tunnels = loadTunnels();
    return { notebooks: (data.items || []).map(n => {
      const bound = tunnels.filter(t => sameBinding(t.inspire, { account, workspace, notebook: n.name }));
      const existing = bound.length === 1 ? bound[0] : null;
      const restricted = restrictedNotebook(n);
      return { name: n.name, status: n.status, project: n.project, group: n.compute_group,
        restricted, localPort: existing?.port || null, tunnelId: existing?.id || null };
    }) };
  }
  async function connect(body) {
    if (starting || job?.status === 'running') throw new Error('已有连接任务正在进行');
    starting = true;
    try {
      const account = label(body.account, '账号');
      const workspace = label(body.workspace, '工作空间');
      const notebook = label(body.notebook, 'Notebook');
      const name = `inspire:${account}:${workspace}:${notebook}`;
      const binding = { account, workspace, notebook };
      const selectedId = body.tunnelId ? label(body.tunnelId, '本地连接') : null;
      const tunnels = loadTunnels();
      const existing = selectedId ? tunnels.find(t => t.id === selectedId) : findConnection(tunnels, binding);
      if (selectedId && !existing) throw new Error('所选本地连接不存在，请刷新后重试');
      if (existing && body.expectedPort != null && Number(body.expectedPort) !== existing.port) throw new Error('本地端口已变化，请刷新列表后重试');
      if (existing?.useSudo) throw new Error('该连接需要 sudo，请先在列表中改用非特权端口');
      const requestedPort = body.localPort === '' || body.localPort == null ? null : Number(body.localPort);
      if (requestedPort != null && (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)) throw new Error('本地端口必须在 1024–65535 之间');
      const snapshot = existing ? JSON.stringify(existingConfig(existing)) : null;
      const localPort = requestedPort || existing?.port || null;
      job = { id: crypto.randomUUID(), status: 'running', notebook, localPort,
        message: '正在解析 Notebook', startedAt: new Date().toISOString(), error: null };
      const current = job;
      establish(current, { account, workspace, notebook, name, binding, requestedPort, selectedId,
        existingId: existing?.id, snapshot, allowStart: body.allowStart === true }).then(() => {
        current.status = 'succeeded';
        current.message = '已连接';
      }).catch(error => {
        current.status = 'failed';
        current.message = '连接失败';
        current.error = redact(error.message).slice(-4000);
      });
      return { job: { ...job } };
    } finally { starting = false; }
  }
  async function establish(current, { account, workspace, notebook, name, binding, requestedPort, selectedId, existingId, snapshot, allowStart }) {
    const scope = ['--account', account, '--workspace', workspace];
    const listing = await cli(['notebook', 'list', '--all', ...scope]);
    const matches = (listing.items || []).filter(n => n.name === notebook);
    if (matches.length !== 1) throw new Error('Notebook 名称不存在或存在重名，请刷新列表');
    const row = matches[0];
    if (restrictedNotebook(row)) throw new Error('此机器使用 Jupyter Terminal，不支持 SSH 隧道');
    let state = row.status;
    if (state === 'STOPPED') {
      if (!allowStart) throw new Error('Notebook 已停止；请刷新列表，并明确确认“启动并连接”后重试');
      current.message = '正在启动 Notebook';
      await cli(['notebook', 'start', notebook, ...scope, '--wait', '--post-start', 'none'], 600000);
      state = 'STARTING';
    }
    const deadline = Date.now() + 600000;
    while (['STARTING', 'CREATING', 'PENDING'].includes(state)) {
      if (Date.now() >= deadline) throw new Error('等待 Notebook 就绪超时');
      current.message = '等待 Notebook 就绪';
      const data = await cli(['notebook', 'status', notebook, ...scope]);
      state = data.status;
      if (['STARTING', 'CREATING', 'PENDING'].includes(state)) await wait(3000);
    }
    if (state !== 'RUNNING') throw new Error('Notebook 当前状态无法连接：' + state);
    current.message = '正在识别已有本地连接';
    const access = await cli(['notebook', 'proxy-url', notebook, ...scope, '--port', '31337']);
    validateURL(access.url);
    const before = loadTunnels();
    const old = findConnection(before, binding, access.url, selectedId);
    if (existingId && (!old || old.id !== existingId || JSON.stringify(existingConfig(old)) !== snapshot)) throw new Error('连接配置已变化，请刷新后重试');
    if (old?.useSudo) throw new Error('该连接需要 sudo，请在列表中处理');
    const localPort = requestedPort || old?.port || await freePort(before.map(t => t.port));
    current.localPort = localPort;
    if (before.some(t => t.port === localPort && t.id !== old?.id && t.status === 'running')) throw new Error('该端口已分配给其他运行中的隧道');
    if (!(old?.status === 'running' && old.port === localPort)) await checkPort(localPort);
    const original = old ? JSON.stringify(existingConfig(old)) : null;
    current.message = '正在准备远端 SSH 和隧道服务';
    await cli(['notebook', 'connection', 'refresh', notebook, ...scope,
      '--port', '31337', '--ssh-port', '22222', '--timeout', '600'], 630000);
    current.message = '正在获取当前访问地址';
    const data = await cli(['notebook', 'proxy-url', notebook, ...scope, '--port', '31337', '--refresh']);
    validateURL(data.url);
    if (notebookEndpoint(data.url) !== notebookEndpoint(access.url)) throw new Error('Notebook 访问地址标识发生变化，请刷新后重试');
    current.message = '正在更新隧道并验证 SSH';
    const tunnels = loadTunnels();
    const latest = findConnection(tunnels, binding, data.url, selectedId);
    if (latest?.id !== old?.id || (latest && (JSON.stringify(existingConfig(latest)) !== original || latest.status !== old.status || latest.pid !== old.pid)) ||
      tunnels.some(t => t.port === localPort && t.id !== old?.id && t.status === 'running')) throw new Error('连接配置已变化，请检查端口后重试');
    if (!(old?.status === 'running' && old.port === localPort)) await checkPort(localPort);
    const config = { name, user: 'root', args: '',
      rtunnelCommand: '', useSudo: false, skipDirectCheck: false,
      monitorType: /cpu/i.test(row.compute_group || workspace) ? 'cpu' : 'gpu',
      ...(old ? existingConfig(old) : {}), url: data.url, port: localPort, inspire: binding };
    let route;
    if (old) {
      route = '/api/tunnels/' + encodeURIComponent(old.id);
      const changed = Object.entries(config).some(([key, value]) => key !== 'inspire' && old[key] !== value);
      if (old.status === 'running') {
        if (!changed && await probe(localPort)) {
          if (!sameBinding(old.inspire, binding)) await request('PUT', route, config);
          return;
        }
        await request('POST', route + '/stop', {});
      }
      await request('PUT', route, config);
    } else {
      const created = await request('POST', '/api/tunnels', config);
      route = '/api/tunnels/' + encodeURIComponent(created.tunnel.id);
    }
    await request('POST', route + '/start', {});
    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
      if (await probe(localPort)) return;
      await wait(1000);
    }
    throw new Error('隧道已启动，但 SSH 尚未就绪，请查看隧道日志');
  }
  return { accounts, workspaces, notebooks, connect, status: () => ({ job,
    capabilities: { notebookBinding: true, explicitStart: true, duplicateGuard: true } }) };
}

function existingConfig(t) {
  return Object.fromEntries(['name', 'url', 'port', 'user', 'args', 'rtunnelCommand', 'useSudo', 'skipDirectCheck', 'monitorType', 'inspire']
    .filter(key => t[key] !== undefined).map(key => [key, t[key]]));
}

function validateURL(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('Inspire 返回的访问地址无效'); }
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password || /[<>]/.test(value)) throw new Error('Inspire 返回的访问地址无效');
}

function freePort(used) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => used.includes(port) ? freePort(used).then(resolve, reject) : resolve(port));
    });
  });
}

function managerRequest(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { 'Content-Type': 'application/json', 'X-RT-Client': 'inspire-connection' } }, res => {
      let content = '';
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('data', chunk => { content += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        let data;
        try { data = JSON.parse(content); } catch (_) { return reject(new Error('隧道管理器返回无效数据')); }
        if (res.statusCode >= 300) return reject(new Error(redact(data.error || '隧道操作失败')));
        resolve(data);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('隧道操作超时')), 45000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(body == null ? undefined : JSON.stringify(body));
  });
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('本地端口已被占用，请选择其他端口')));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

function sshReady(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = '', finished = false;
    const timer = setTimeout(() => finish(false), 4000);
    function finish(value) {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy(); resolve(value);
    }
    socket.on('data', chunk => {
      data += chunk.toString();
      if (/(^|\n)SSH-2\.0-/.test(data)) finish(true);
      else if (data.length > 4096) finish(false);
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

module.exports = { createInspire, redact, freePort, sshReady, assertPortFree, normalizeBinding, notebookServiceKey, duplicateNotebookConnection };

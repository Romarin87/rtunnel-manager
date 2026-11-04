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
      const existing = tunnels.find(t => t.name === `inspire:${account}:${workspace}:${n.name}`);
      const restricted = restrictedNotebook(n);
      return { name: n.name, status: n.status, project: n.project, group: n.compute_group,
        restricted, localPort: existing?.port || null };
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
      const tunnels = loadTunnels();
      const matches = tunnels.filter(t => t.name === name);
      if (matches.length > 1) throw new Error('存在重名连接，请先在列表中整理');
      const existing = matches[0];
      if (existing?.useSudo) throw new Error('该连接需要 sudo，请先在列表中改用非特权端口');
      let localPort = body.localPort === '' || body.localPort == null ? existing?.port : Number(body.localPort);
      if (localPort == null) localPort = await freePort(tunnels.map(t => t.port));
      if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw new Error('本地端口必须在 1024–65535 之间');
      if (tunnels.some(t => t.port === localPort && t.name !== name)) throw new Error('该端口已分配给其他隧道');
      if (!(existing?.status === 'running' && existing.port === localPort)) await checkPort(localPort);
      job = { id: crypto.randomUUID(), status: 'running', notebook, localPort,
        message: '正在解析 Notebook', startedAt: new Date().toISOString(), error: null };
      const current = job;
      establish(current, { account, workspace, notebook, name, localPort }).then(() => {
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
  async function establish(current, { account, workspace, notebook, name, localPort }) {
    const scope = ['--account', account, '--workspace', workspace];
    const listing = await cli(['notebook', 'list', '--all', ...scope]);
    const matches = (listing.items || []).filter(n => n.name === notebook);
    if (matches.length !== 1) throw new Error('Notebook 名称不存在或存在重名，请刷新列表');
    const row = matches[0];
    if (restrictedNotebook(row)) throw new Error('此机器使用 Jupyter Terminal，不支持 SSH 隧道');
    let state = row.status;
    if (state === 'STOPPED') {
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
    current.message = '正在准备远端 SSH 和隧道服务';
    await cli(['notebook', 'connection', 'refresh', notebook, ...scope,
      '--port', '31337', '--ssh-port', '22222', '--timeout', '600'], 630000);
    current.message = '正在获取当前访问地址';
    const data = await cli(['notebook', 'proxy-url', notebook, ...scope, '--port', '31337', '--refresh']);
    let url;
    try { url = new URL(data.url); } catch (_) { throw new Error('Inspire 返回的访问地址无效'); }
    if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) || url.username || url.password || /[<>]/.test(data.url)) throw new Error('Inspire 返回的访问地址无效');
    current.message = '正在更新隧道并验证 SSH';
    const tunnels = loadTunnels();
    const existing = tunnels.filter(t => t.name === name);
    if (existing.length > 1 || tunnels.some(t => t.port === localPort && t.name !== name)) throw new Error('连接配置已变化，请检查端口后重试');
    const old = existing[0];
    if (old?.useSudo) throw new Error('该连接需要 sudo，请在列表中处理');
    if (!(old?.status === 'running' && old.port === localPort)) await checkPort(localPort);
    const config = { name, url: data.url, port: localPort, user: 'root', args: '',
      rtunnelCommand: '', useSudo: false, skipDirectCheck: false,
      monitorType: workspace === 'CPU资源空间' ? 'cpu' : 'gpu' };
    let route;
    if (old) {
      route = '/api/tunnels/' + encodeURIComponent(old.id);
      const changed = Object.entries(config).some(([key, value]) => old[key] !== value);
      if (old.status === 'running') {
        if (!changed && await probe(localPort)) return;
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
  return { accounts, workspaces, notebooks, connect, status: () => ({ job }) };
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
      headers: { 'Content-Type': 'application/json' } }, res => {
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

module.exports = { createInspire, redact, freePort, sshReady, assertPortFree };

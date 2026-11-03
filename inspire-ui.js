'use strict';

(() => {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.id = 'modal-inspire';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="modal modal-large inspire-modal" role="dialog" aria-modal="true" aria-labelledby="inspire-title">
      <header class="modal-header">
        <h2 id="inspire-title">连接 Notebook</h2>
        <button class="btn btn-icon" id="inspire-close" aria-label="关闭" title="关闭">×</button>
      </header>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field"><label for="inspire-account">账号</label><select id="inspire-account"></select></div>
          <div class="field"><label for="inspire-workspace">工作空间</label><select id="inspire-workspace"></select></div>
        </div>
        <div class="inspire-search">
          <input type="text" id="inspire-search" aria-label="搜索 Notebook" placeholder="搜索名称或项目">
          <button class="btn btn-icon" id="inspire-reload" aria-label="刷新 Notebook" title="刷新 Notebook">↻</button>
        </div>
        <div class="field"><label for="inspire-notebook">Notebook</label><select id="inspire-notebook" size="6"></select></div>
        <p id="inspire-detail"></p>
        <div class="field"><label for="inspire-port">本地端口</label><input type="number" min="1024" max="65535" id="inspire-port" placeholder="自动分配"></div>
        <div id="inspire-progress" role="status" aria-live="polite"></div>
        <pre id="inspire-error" role="alert" hidden></pre>
      </div>
      <footer class="modal-footer">
        <button class="btn btn-ghost btn-sm" id="inspire-dismiss">关闭</button>
        <button class="btn btn-primary btn-sm" id="inspire-connect" disabled>一键连接</button>
      </footer>
    </div>`;
  document.body.appendChild(modal);
  const get = id => document.getElementById('inspire-' + id);
  let rows = [], loading = false, busy = false, generation = 0, job = null, timer = null;
  let lastFocused = null;
  const statusNames = { RUNNING: '运行中', STOPPED: '已停止', PENDING: '排队中', CREATING: '创建中', STARTING: '启动中' };
  const allowed = ['RUNNING', 'STOPPED', 'PENDING', 'CREATING', 'STARTING'];
  const selection = () => rows.find(row => row.name === get('notebook').value);
  function error(message) {
    get('error').textContent = message || '';
    get('error').hidden = !message;
  }
  function controls() {
    for (const id of ['account', 'workspace', 'search', 'reload', 'notebook', 'port']) get(id).disabled = busy || loading;
    const row = selection();
    get('connect').disabled = busy || loading || !row || row.restricted || !allowed.includes(row.status);
    get('connect').textContent = busy ? '连接中…' : row?.status === 'STOPPED' ? '启动并连接' : '一键连接';
    document.getElementById('open-inspire').textContent = busy ? 'Notebook 连接中…' : '连接 Notebook';
  }
  function details() {
    const row = selection();
    get('detail').textContent = row
      ? [row.project, row.group, row.restricted ? '此机器使用 Jupyter Terminal，不支持 SSH 隧道' : statusNames[row.status] || row.status].filter(Boolean).join(' · ')
      : '没有匹配的 Notebook';
    get('port').value = row?.localPort || '';
    controls();
  }
  function render() {
    const previous = get('notebook').value;
    const term = get('search').value.toLowerCase();
    const filtered = rows.filter(row => (row.name + ' ' + row.project).toLowerCase().includes(term));
    get('notebook').replaceChildren(...filtered.map(row => new Option(
      row.name + '  ·  ' + (statusNames[row.status] || row.status) + (row.restricted ? ' · Jupyter' : ''), row.name,
    )));
    get('notebook').value = filtered.some(row => row.name === previous) ? previous : filtered[0]?.name || '';
    details();
  }
  function query() { return new URLSearchParams({ account: get('account').value, workspace: get('workspace').value }); }
  async function loadNotebooks() {
    const current = ++generation;
    loading = true; error(''); rows = []; render();
    get('progress').textContent = '正在读取 Notebook…';
    try {
      const data = await api('/api/inspire/notebooks?' + query());
      if (current !== generation) return;
      rows = data.notebooks || [];
      render();
      get('progress').textContent = rows.length ? rows.length + ' 台 Notebook' : '该工作空间没有 Notebook';
    } catch (e) { if (current === generation) { error(e.message); get('progress').textContent = '读取失败'; } }
    finally { if (current === generation) { loading = false; controls(); } }
  }
  async function loadWorkspaces() {
    loading = true; controls(); error('');
    get('workspace').replaceChildren(); rows = []; render();
    get('progress').textContent = '正在读取工作空间…';
    try {
      const data = await api('/api/inspire/workspaces?' + query());
      const spaces = data.workspaces || [];
      get('workspace').replaceChildren(...spaces.map(name => new Option(name, name)));
      if (spaces.includes('CPU资源空间')) get('workspace').value = 'CPU资源空间';
      if (spaces.length) await loadNotebooks();
      else get('progress').textContent = '此账号没有可用工作空间';
    } catch (e) { error(e.message); }
    finally { loading = false; controls(); }
  }
  async function loadAccounts() {
    loading = true; controls(); error('');
    get('progress').textContent = '正在读取 Inspire 账号…';
    try {
      const data = await api('/api/inspire/accounts');
      get('account').replaceChildren(...data.accounts.map(a => new Option(a.name, a.name, a.active, a.active)));
      if (!data.accounts.length) throw new Error('没有已登录的 Inspire 账号');
      await loadWorkspaces();
    } catch (e) { error(e.message); get('progress').textContent = '读取失败'; }
    finally { loading = false; controls(); }
  }
  async function poll() {
    clearTimeout(timer);
    try {
      const data = await api('/api/inspire/status');
      if (data.job) job = data.job;
      busy = job?.status === 'running';
      controls();
      if (job) {
        get('progress').textContent = job.notebook + ' · ' + job.message;
        if (job.status === 'succeeded') {
          get('progress').textContent += ' · ssh -p ' + job.localPort + ' root@127.0.0.1';
          refresh();
        }
        error(job.error);
      }
    } catch (e) { error('进度读取失败：' + e.message); }
    if (busy) timer = setTimeout(poll, 1500);
  }
  async function open() {
    lastFocused = document.activeElement;
    modal.hidden = false;
    await poll();
    if (!busy) await loadAccounts();
    if (!modal.hidden) get('account').focus();
  }
  function close() { modal.hidden = true; lastFocused?.focus(); }
  get('connect').addEventListener('click', async () => {
    const row = selection();
    if (!row || busy) return;
    if (get('port').value && !get('port').checkValidity()) { get('port').reportValidity(); return; }
    busy = true; controls(); error('');
    get('progress').textContent = '正在建立连接…';
    try {
      const data = await api('/api/inspire/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: get('account').value, workspace: get('workspace').value, notebook: row.name, localPort: get('port').value }),
      });
      job = data.job;
      get('port').value = job.localPort;
      await poll();
    } catch (e) { busy = false; controls(); error(e.message); get('progress').textContent = '连接失败'; }
  });
  get('account').addEventListener('change', loadWorkspaces);
  get('workspace').addEventListener('change', loadNotebooks);
  get('reload').addEventListener('click', () => get('workspace').value ? loadNotebooks() : loadAccounts());
  get('search').addEventListener('input', render);
  get('notebook').addEventListener('change', details);
  get('close').addEventListener('click', close);
  get('dismiss').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const elements = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      const first = elements[0], last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.getElementById('open-inspire').addEventListener('click', open);
  poll();
})();

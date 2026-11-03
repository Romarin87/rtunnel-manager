'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const groups = new Set();

function redact(value) {
  return String(value || '')
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[访问地址]')
    .replace(/^(\s*(?:-\s*)?(?:cookie|set-cookie|authorization)\s*:).*$/gim, '$1 [已隐藏]')
    .replace(/((?:cookie|set-cookie|authorization|[\w-]*(?:token|password|secret))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[已隐藏]');
}

function signalGroup(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
}
process.once('exit', () => { for (const child of groups) signalGroup(child, 'SIGKILL'); });

function environment() {
  const env = { ...process.env, INSPIRE_SKIP_UPDATE_CHECK: '1', PYTHONUNBUFFERED: '1' };
  env.PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH || '/usr/bin:/bin'].join(path.delimiter);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  return env;
}

function resolveCLI(env) {
  const candidates = process.env.RT_INSPIRE_BIN ? [process.env.RT_INSPIRE_BIN]
    : env.PATH.split(path.delimiter).map(dir => path.join(dir, 'inspire'));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  throw new Error('未找到 Inspire CLI。请按 README 安装 inspire-skill 7.1.14 或更新版本并登录账号');
}

// An isolated process group lets timeout and app exit clean up CLI descendants.
function runProcess(bin, args, { timeout = 120000, env = environment(), grace = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    groups.add(child);
    let stdout = '', stderr = '', failure = null, escalation = null, settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation);
      groups.delete(child);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(stdout);
    }
    function abort(message) {
      if (failure) return;
      failure = new Error(message);
      signalGroup(child, 'SIGTERM');
      escalation = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        finish(failure);
      }, grace);
    }
    const timer = setTimeout(() => abort('Inspire 操作超时，已终止本次 CLI 进程组；请检查 Notebook 状态后重试'), timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2000000) { stdout = ''; abort('Inspire 输出超过限制'); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.once('error', error => finish(new Error(redact(error.message))));
    child.once('close', code => {
      // Keep the escalation armed even if a descendant closed its inherited pipes.
      if (failure) return;
      finish(code === 0 ? null : new Error(redact(stderr || stdout || `Inspire 退出 (${code})`)));
    });
  });
}

function runCLI(args, timeout) {
  const env = environment();
  return runProcess(resolveCLI(env), args, { timeout, env });
}

module.exports = { runCLI, runProcess, resolveCLI, redact };

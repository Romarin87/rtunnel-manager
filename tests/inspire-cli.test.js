'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProcess } = require('../inspire-cli');
test('timeout kills child and descendant ignoring SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtunnel-cli-test-'));
  const pidFile = path.join(dir, 'pid');
  const descendant = "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const parent = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const started = Date.now();
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', parent, pidFile], { timeout: 800, grace: 100 }), /超时/);
    assert.ok(Date.now() - started < 3000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    }
    assert.equal(alive, false, 'descendant must not survive timeout');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('arguments stay literal and errors redact credentials', async () => {
  const literal = 'a; $(echo secret)';
  assert.equal(await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]), literal);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("failed https://host/secret-path");process.exit(1)']), error => !error.message.includes('secret-path'));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../package.json');

test('app package contains only application assets', () => {
  assert.deepEqual([...build.files].sort(), [
    'electron-main.js', 'server.js', 'inspire.js', 'inspire-cli.js',
    'inspire-ui.js', 'inspire-ui.css', 'package.json',
  ].sort());
  assert.deepEqual(build.extraResources || [], []);
  assert.deepEqual(build.extraFiles || [], []);
});

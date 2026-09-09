'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Windows launcher prints its instructions without executing them as commands', {
  skip: process.platform !== 'win32',
}, () => {
  // Preserve original line endings: normalizing here would hide the CMD bug.
  const source = fs.readFileSync(path.join(__dirname, '../web/start.bat'), 'utf8')
    .replace(/^(?:node |pause|cd |set )[^\n]*(?:\n|$)/gm, '');
  const file = path.join(os.tmpdir(), 'vinyl-launcher-' + process.pid + '.cmd');
  try {
    fs.writeFileSync(file, source);
    const result = spawnSync('cmd.exe', ['/d', '/c', file], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /http:\/\/localhost:3000/);
    assert.match(result.stdout, /Ctrl\+C/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

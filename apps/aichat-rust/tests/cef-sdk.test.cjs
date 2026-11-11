const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('CEF SDK selection and bounded download/extraction use isolated HTTP fixtures', () => {
  const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [path.resolve(__dirname, '../windows/tests/sdk_test.py')], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

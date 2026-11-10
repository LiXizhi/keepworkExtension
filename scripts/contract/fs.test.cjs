const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./harness.cjs');

let rust;
let node;
const engines = [];

function fixture(engine) {
  const root = path.join(engine.home, 'fixture');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world');
  fs.writeFileSync(path.join(root, 'sub', 'b.md'), '# needle');
  return root;
}

async function json(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

/** Runs the same scenario against Rust and, when built, the Node reference. */
async function both(run) {
  const results = [];
  for (const engine of engines) {
    results.push(await run(engine));
  }
  if (results.length === 2) {
    assert.deepEqual(results[0], results[1], 'Rust must match the Node reference');
  }
  return results[0];
}

before(async () => {
  rust = await h.startRust();
  node = await h.startNode();
  engines.push(...[rust, node].filter(Boolean));
  for (const engine of engines) {
    engine.fixture = fixture(engine);
  }
});

after(async () => {
  await rust?.stop();
  await node?.stop();
});

test('list keeps the Node entry shape, ordering and truncation', async () => {
  const result = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/list?root=${encodeURIComponent(engine.fixture)}`,
    );
    return { status: body.status, ok: body.body.ok, entries: body.body.entries };
  });
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.kind, entry.symlink]),
    [
      ['sub', 'directory', false],
      ['a.txt', 'file', false],
    ],
  );
});

test('list honours max and reports truncation', async () => {
  const result = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/list?root=${encodeURIComponent(engine.fixture)}&max=1`,
    );
    return { entries: body.body.entries.length, truncated: body.body.truncated };
  });
  assert.deepEqual(result, { entries: 1, truncated: true });
});

test('recursive listing walks nested directories', async () => {
  const result = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/list?root=${encodeURIComponent(engine.fixture)}&recursive=1`,
    );
    return body.body.files;
  });
  assert.deepEqual(result.sort(), ['a.txt', 'sub/b.md']);
});

test('search matches names and skips nothing it should see', async () => {
  const result = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/search?root=${encodeURIComponent(engine.fixture)}&q=md`,
    );
    return { files: body.body.files, truncated: body.body.truncated };
  });
  assert.deepEqual(result.files, ['sub/b.md']);
  assert.equal(result.truncated, false);
});

test('stat keeps the Node payload and never escapes the root', async () => {
  const stat = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/stat?root=${encodeURIComponent(engine.fixture)}&path=a.txt`,
    );
    return { status: body.status, body: body.body };
  });
  assert.equal(stat.status, 200);
  assert.equal(stat.body.exists, true);
  assert.equal(stat.body.isFile, true);
  assert.equal(stat.body.size, 11);
  assert.equal(stat.body.rel, 'a.txt');

  const escape = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/stat?root=${encodeURIComponent(engine.fixture)}&path=../etc/passwd`,
    );
    return { status: body.status, error: body.body.error };
  });
  assert.equal(escape.status, 400);
  assert.match(escape.error, /escapes root/i);
});

test('file read streams bytes with Node headers', async () => {
  const result = await both(async (engine) => {
    const response = await fetch(
      `${engine.base}/fs/file?root=${encodeURIComponent(engine.fixture)}&path=a.txt`,
    );
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      cache: response.headers.get('cache-control'),
      nosniff: response.headers.get('x-content-type-options'),
      searchPath: response.headers.get('x-search-path'),
      text: await response.text(),
    };
  });
  assert.equal(result.status, 200);
  assert.equal(result.type, 'text/plain');
  assert.equal(result.cache, 'no-store');
  assert.equal(result.nosniff, 'nosniff');
  assert.equal(result.searchPath, 'a.txt');
  assert.equal(result.text, 'hello world');
});

test('file read supports base64 envelopes', async () => {
  const result = await both(async (engine) => {
    const body = await json(
      `${engine.base}/fs/file?root=${encodeURIComponent(engine.fixture)}&path=a.txt&base64=1`,
    );
    return { size: body.body.size, base64: body.body.base64, rel: body.body.rel };
  });
  assert.deepEqual(result, { size: 11, base64: 'aGVsbG8gd29ybGQ=', rel: 'a.txt' });
});

test('file write, mkdir, delete round-trip', async () => {
  const result = await both(async (engine) => {
    const root = encodeURIComponent(engine.fixture);
    const put = await json(`${engine.base}/fs/file?root=${root}&path=out/new.txt`, {
      method: 'PUT',
      body: 'written',
    });
    const read = await fetch(`${engine.base}/fs/file?root=${root}&path=out/new.txt`).then((r) => r.text());
    const dir = await json(`${engine.base}/fs/dir?root=${root}&path=empty`, { method: 'PUT' });
    const exists = fs.existsSync(path.join(engine.fixture, 'empty'));
    const removeFile = await json(`${engine.base}/fs/file?root=${root}&path=out/new.txt`, {
      method: 'DELETE',
    });
    const removeDir = await json(`${engine.base}/fs/dir?root=${root}&path=empty`, {
      method: 'DELETE',
    });
    return {
      put: [put.status, put.body.ok, put.body.size],
      read,
      dir: [dir.status, dir.body.created],
      exists,
      removeFile: [removeFile.status, removeFile.body.ok],
      removeDir: [removeDir.status, removeDir.body.ok],
      gone: fs.existsSync(path.join(engine.fixture, 'out', 'new.txt')),
    };
  });
  assert.deepEqual(result, {
    put: [200, true, 7],
    read: 'written',
    dir: [200, true],
    exists: true,
    removeFile: [200, true],
    removeDir: [200, true],
    gone: false,
  });
});

test('missing root and missing path keep Node error text', async () => {
  const result = await both(async (engine) => {
    const noRoot = await json(`${engine.base}/fs/list?root=relative`);
    const noPath = await json(`${engine.base}/fs/file?root=${encodeURIComponent(engine.fixture)}`);
    return {
      noRoot: [noRoot.status, noRoot.body.error],
      noPath: [noPath.status, noPath.body.error],
    };
  });
  assert.deepEqual(result.noRoot, [400, 'root must be an absolute disk path']);
  assert.deepEqual(result.noPath, [400, 'path is required']);
});

test('unknown fs route answers 404 like Node', async () => {
  const result = await both(async (engine) => {
    const body = await json(`${engine.base}/fs/nope?root=${encodeURIComponent(engine.fixture)}`);
    return [body.status, body.body.ok, body.body.error];
  });
  assert.deepEqual(result, [404, false, 'not found']);
});

test('folder locations keep the Node envelope', async () => {
  const result = await both(async (engine) => {
    const body = await json(`${engine.base}/fs/locations`);
    return {
      status: body.status,
      ok: body.body.ok,
      platform: body.body.platform,
      firstId: body.body.locations[0].id,
      firstIsHome: body.body.locations[0].path === engine.home.replace(/\/$/, ''),
      hasVolumes: Array.isArray(body.body.volumes) && body.body.volumes.length > 0,
    };
  });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.platform, process.platform);
  assert.equal(result.firstId, 'home');
  assert.equal(result.hasVolumes, true);
});

test('browse lists only directories with pagination fields', async () => {
  const result = await both(async (engine) => {
    // A dedicated folder so earlier write/delete tests cannot leak into it.
    const browseRoot = path.join(engine.home, 'browse');
    fs.mkdirSync(path.join(browseRoot, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(browseRoot, 'file.txt'), 'x');
    const body = await json(
      `${engine.base}/fs/browse?path=${encodeURIComponent(browseRoot)}&limit=1`,
    );
    return {
      status: body.status,
      ok: body.body.ok,
      names: body.body.entries.map((entry) => entry.name),
      total: body.body.total,
      nextOffset: body.body.nextOffset,
      breadcrumbRoot: body.body.breadcrumbs[0].name,
    };
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.names, ['sub']);
  assert.equal(result.total, 1);
  assert.equal(result.nextOffset, null);
});

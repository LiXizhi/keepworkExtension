const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {compileFunction} = require('node:vm');
const ts = require('typescript');

const filename = path.join(__dirname, '../src/core/personaCredentials.ts');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;

function loadVault(platform, spawnSync) {
    const exports = {};
    const resolve = id => id === 'node:child_process' && spawnSync ? {spawnSync} : require(id);
    compileFunction(code, ['require', 'exports', 'process'], {filename})(resolve, exports, {platform, env: process.env});
    return exports.createPersonaCredentialVault;
}

const scope = 'test-owned-scope';
const token = 'kwcrm_' + 'd'.repeat(64);

test('Windows CurrentUser DPAPI opens synthetic credentials after restart and rejects a different scope', {
    skip: process.platform !== 'win32',
}, () => {
    const createVault = loadVault('win32');
    const sealed = createVault().seal(scope, token);
    assert.match(sealed, /^dpapi1:/);
    assert.equal(sealed.includes(token), false);
    assert.ok(createVault().open(scope, sealed) === token);
    assert.throws(() => createVault().open('different-scope', sealed));
    assert.throws(() => createVault().open(scope, sealed.slice(0, 20)));
});

// Simulate only the OS keyring process. Envelope encryption, authentication,
// key selection and argument construction use the production implementation.
function keyringFixture(platform) {
    const keys = new Map();
    const calls = [];
    let unavailable = false;
    const ok = (stdout = '') => ({status: 0, stdout});
    const failure = () => ({status: 1, stdout: ''});
    function spawn(program, args, options) {
        calls.push({program, args});
        if (unavailable) return failure();
        if (platform === 'darwin') {
            assert.equal(program, '/usr/bin/security');
            if (args[0] === '-i') {
                const command = /^add-generic-password -s (\S+) -a ([a-f0-9]{64}) -w ([a-f0-9]{64})\s*$/.exec(options.input);
                assert.ok(command, 'expected a keychain write through stdin');
                keys.set(command[2], command[3]);
                return ok();
            }
            assert.equal(args[0], 'find-generic-password');
            const index = args.indexOf('-a');
            const value = index === -1 ? keys.values().next().value : keys.get(args[index + 1]);
            return value ? ok(value) : failure();
        }
        assert.equal(program, '/usr/bin/secret-tool');
        if (args[0] === 'store') {
            assert.match(options.input, /^[a-f0-9]{64}$/);
            keys.set(args[args.indexOf('account') + 1], options.input);
            return ok();
        }
        assert.equal(args[0], 'lookup');
        const index = args.indexOf('account');
        const value = index === -1 ? keys.values().next().value : keys.get(args[index + 1]);
        return value ? ok(value) : failure();
    }
    return {keys, calls, createVault: loadVault(platform, spawn), lock: () => {unavailable = true;}};
}

for (const platform of ['darwin', 'linux']) {
    test(platform + ' credential envelopes survive restart and reject tampering and an unavailable keyring', () => {
        const {createVault, keys, calls, lock} = keyringFixture(platform);
        const sealed = createVault().seal(scope, token);
        assert.equal(keys.size, 1);
        assert.equal(sealed.includes(token), false);
        assert.ok(createVault().open(scope, sealed) === token);
        assert.throws(() => createVault().open('different-scope', sealed));
        const [version, id, payload] = sealed.split(':');
        const bytes = Buffer.from(payload, 'base64');
        bytes[bytes.length - 1] ^= 1;
        assert.throws(() => createVault().open(scope, [version, id, bytes.toString('base64')].join(':')));
        const argv = JSON.stringify(calls);
        assert.equal(argv.includes(token), false);
        for (const key of keys.values()) assert.equal(argv.includes(key), false, 'key sent in process arguments');
        keys.clear();
        assert.throws(() => createVault().open(scope, sealed));
        assert.equal(keys.size, 0, 'reading a missing key must preserve recoverability');
        lock();
        assert.throws(() => createVault().seal(scope, token));
    });
}

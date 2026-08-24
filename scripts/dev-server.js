const { spawn } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { homedir } = require('os');
const { join, resolve } = require('path');

const projectRoot = resolve(__dirname, '..');
const port = 8089;
const baseUrl = `http://127.0.0.1:${port}`;
const tscPath = join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
let serverProcess;
let restarting = Promise.resolve();

function readToken() {
    const tokenFile = join(homedir(), '.keepwork-mcp', 'token');
    return existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
}

async function stopRunningDaemon() {
    try {
        const health = await fetch(`${baseUrl}/health`);
        const status = await health.json();
        if (status.name !== 'keepwork-mcp') {
            throw new Error(`port ${port} is occupied by another service`);
        }

        const token = readToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(`${baseUrl}/admin/stop`, { method: 'POST', headers });
        if (!response.ok) {
            throw new Error(`unable to stop the existing daemon (HTTP ${response.status})`);
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
    } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') return;
        throw error;
    }
}

function stopChild(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise(resolvePromise => {
        child.once('exit', resolvePromise);
        child.kill('SIGTERM');
    });
}

async function restartServer() {
    await stopChild(serverProcess);
    serverProcess = spawn(process.execPath, ['out/cli.js', '--port', String(port)], {
        cwd: projectRoot,
        stdio: 'inherit',
    });
    serverProcess.once('exit', code => {
        if (code && code !== 0) console.error(`[dev-server] MCP server exited with code ${code}`);
    });
}

async function main() {
    await stopRunningDaemon();

    const compiler = spawn(process.execPath, [tscPath, '--watch', '-p', projectRoot], {
        cwd: projectRoot,
        stdio: ['inherit', 'pipe', 'pipe'],
    });
    let compilerOutput = '';
    const handleCompilerOutput = chunk => {
        const text = chunk.toString();
        process.stdout.write(text);
        compilerOutput = (compilerOutput + text).slice(-4096);
        if (/Found 0 errors\. Watching for file changes\./.test(compilerOutput)) {
            compilerOutput = '';
            restarting = restarting.then(restartServer).catch(error => {
                console.error(`[dev-server] ${error.message}`);
            });
        }
    };
    compiler.stdout.on('data', handleCompilerOutput);
    compiler.stderr.on('data', chunk => process.stderr.write(chunk));

    const shutdown = async () => {
        compiler.kill('SIGTERM');
        await stopChild(serverProcess);
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    compiler.once('exit', code => {
        void stopChild(serverProcess).then(() => process.exit(code ?? 1));
    });
}

main().catch(error => {
    console.error(`[dev-server] ${error.message}`);
    process.exit(1);
});
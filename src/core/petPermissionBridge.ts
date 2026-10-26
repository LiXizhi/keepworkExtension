import { createServer, Server, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureMcpHome } from './config';
import { PermissionPet, ScreenshotChoice, ScreenshotPermission } from './screenshotPermission';

export class PetPermissionBridge implements PermissionPet {
    private server?: Server;
    private starting?: Promise<void>;
    private peer?: Socket;
    private peerRole = '';
    private child?: ChildProcess;
    private sockets = new Set<Socket>();
    private ready = new Set<() => void>();
    private token = randomBytes(32).toString('hex');
    private pending?: { id: string; resolve: (choice: ScreenshotChoice) => void; reject: (error: Error) => void };
    private closed = false;
    private discovery = '';
    constructor(private launch = defaultLaunch, private home = ensureMcpHome) {}
    start(): Promise<void> {
        if (this.starting) return this.starting;
        this.closed = false;
        this.starting = new Promise((resolve, reject) => {
            this.server = createServer(socket => this.accept(socket));
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                try {
                    this.discovery = path.join(this.home(), 'pet-permission-bridge.json');
                    const record = { pid: process.pid, port: (this.server!.address() as import('node:net').AddressInfo).port, token: this.token };
                    const temporary = this.discovery + '.' + process.pid;
                    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
                    fs.renameSync(temporary, this.discovery); resolve();
                } catch (error) { reject(error); }
            });
        });
        return this.starting;
    }
    private send(value: unknown) { this.peer?.write(JSON.stringify(value) + '\n'); }
    private accept(socket: Socket) {
        this.sockets.add(socket);
        let buffer = '', authenticated = false;
        const handshake = setTimeout(() => socket.destroy(), 5000);
        socket.setNoDelay(true);
        socket.on('error', () => socket.destroy());
        socket.on('data', data => {
            buffer += data.toString();
            if (buffer.length > 8192) { socket.destroy(); return; }
            for (let index; (index = buffer.indexOf('\n')) >= 0;) {
                const line = buffer.slice(0,index); buffer = buffer.slice(index+1);
                try {
                    const message = JSON.parse(line);
                    if (!authenticated) {
                        if (message.token !== this.token || !['desktop','companion'].includes(message.role)) throw Error('Unauthorized pet');
                        if (this.peer && !(message.role === 'desktop' && this.peerRole === 'companion' && !this.pending)) {
                            socket.write(JSON.stringify({ type: 'retire' }) + '\n'); socket.end(); return;
                        }
                        if (this.peer) { this.send({ type: 'retire' }); this.peer.end(); }
                        authenticated = true; clearTimeout(handshake); this.peer = socket; this.peerRole = message.role;
                        socket.write(JSON.stringify({ type: 'ready' }) + '\n');
                        for (const callback of this.ready) callback();
                    } else if (socket === this.peer && message.type === 'choice' && message.id === this.pending?.id && ['once','always','cancel'].includes(message.choice)) {
                        const item = this.pending!; this.pending = undefined; item.resolve(message.choice);
                    }
                } catch { socket.destroy(); }
            }
        });
        socket.on('close', () => {
            clearTimeout(handshake); this.sockets.delete(socket);
            if (this.peer !== socket) return;
            this.peer = undefined; this.peerRole = '';
            this.pending?.reject(new Error('Permission pet closed or disconnected')); this.pending = undefined;
        });
    }
    private async ensurePet(signal: AbortSignal) {
        await this.start(); signal.throwIfAborted();
        if (this.peer) return;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.ready.delete(connected); signal.removeEventListener('abort', aborted); if (error) { if (!this.peer) { this.child?.kill(); this.child = undefined; } reject(error); } else resolve(); };
            const connected = () => finish();
            const aborted = () => finish(new Error('Screenshot request cancelled'));
            // Startup has a deadline. User approval never has one.
            const timer = setTimeout(() => finish(new Error('Permission pet could not start. Repair the bundled pet companion and try again.')), 20000);
            this.ready.add(connected); signal.addEventListener('abort', aborted, { once: true });
            try {
                if (!this.child || this.child.exitCode !== null) {
                    const child = this.launch(); this.child = child;
                    child.once('error', () => finish(new Error('Permission pet failed to launch. Repair the bundled companion.')));
                    child.once('exit', () => { if (this.child === child) this.child = undefined; if (!this.peer) finish(new Error('Permission pet exited')); });
                }
            } catch (error) { finish(error as Error); }
        });
    }
    async request(request: { id: string; client: string }, signal: AbortSignal): Promise<ScreenshotChoice> {
        if (this.closed) throw Error('Permission service stopped');
        if (this.pending) throw Error('Permission pet is busy');
        await this.ensurePet(signal); signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = () => { if (this.pending?.id !== request.id) return; this.send({ type: 'cancel', id: request.id }); this.pending = undefined; cleanup(); reject(new Error('Screenshot request cancelled')); };
            const cleanup = () => signal.removeEventListener('abort', abort);
            this.pending = { id: request.id, resolve: choice => { cleanup(); resolve(choice); }, reject: error => { cleanup(); reject(error); } };
            signal.addEventListener('abort', abort, { once: true });
            this.send({ type: 'permission', ...request });
        });
    }
    restorePet() { this.send({ type: 'restore' }); }
    close() {
        this.closed = true; this.pending?.reject(new Error('Daemon stopped')); this.pending = undefined;
        this.send({ type: 'cancel' });
        for (const socket of this.sockets) socket.destroy();
        this.child?.kill(); this.server?.close(); this.server = undefined; this.starting = undefined; this.peer = undefined; this.child = undefined;
        try { if (JSON.parse(fs.readFileSync(this.discovery,'utf8')).token === this.token) fs.unlinkSync(this.discovery); } catch {}
    }
}
function defaultLaunch(): ChildProcess {
    const directory = [path.join(__dirname.replace('app.asar', 'app.asar.unpacked'),'pet-companion'), path.join(__dirname,'pet-companion'), path.join(__dirname,'../pet')].find(dir => fs.existsSync(path.join(dir,'companion.cjs')));
    if (!directory) throw Error('Bundled permission pet is missing. Repair this Keepwork MCP installation.');
    const executable = process.platform === 'darwin' ? path.join(directory,'electron/Electron.app/Contents/MacOS/Electron') : path.join(directory,'electron/electron.exe');
    const nested = path.join(directory,'electron',`${process.platform}-${process.arch}`,process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe');
    let electron = fs.existsSync(nested) ? nested : executable;
    if (!fs.existsSync(electron)) {
        const packageRoot = path.resolve(directory,'../../apps/pet-companion/node_modules/electron');
        const relative = fs.readFileSync(path.join(packageRoot,'path.txt'),'utf8').trim();
        electron = path.join(packageRoot,'dist',relative);
    }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    return spawn(electron, [path.join(directory,'companion.cjs')], { windowsHide: true, stdio: 'ignore', env });
}
export const petPermissionBridge = new PetPermissionBridge();
export const screenshotPermission = new ScreenshotPermission(petPermissionBridge);

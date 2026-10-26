import { randomUUID } from 'node:crypto';
import { readConfigFile, writeConfigFile } from './config';
export type ScreenshotChoice = 'once' | 'always' | 'cancel';
export interface PermissionPet {
    request(request: { id: string; client: string }, signal: AbortSignal): Promise<ScreenshotChoice>;
}
/** One daemon-owned authority, never a model-supplied approval flag. */
export class ScreenshotPermission {
    private pending?: { owner: string; controller: AbortController };
    private revision = 0;
    constructor(private pet: PermissionPet,
        private read = () => readConfigFile().alwaysAllowScreenshots === true,
        private write = (value: boolean) => writeConfigFile({ alwaysAllowScreenshots: value })) {}
    get waitingOwner() { return this.pending?.owner; }
    status() { return { alwaysAllowScreenshots: this.read(), pending: !!this.pending }; }
    disable() { this.revision++; this.write(false); this.pending?.controller.abort(new Error('Screenshot permission changed; request again')); }
    cancelOwner(owner: string) { if (this.pending?.owner === owner) this.pending.controller.abort(new Error('MCP session closed')); }
    close() { this.pending?.controller.abort(new Error('Daemon stopped')); }
    async authorize(owner: string, client: string, signal?: AbortSignal, setting = false): Promise<void> {
        signal?.throwIfAborted();
        if (this.pending) throw Error('Desktop permission is busy');
        if (this.read() && !setting) return;
        const controller = new AbortController(), revision = this.revision;
        const abort = () => controller.abort(signal?.reason || new Error('Screenshot request cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        this.pending = { owner, controller };
        try {
            const choice = await this.pet.request({ id: randomUUID(), client: client.slice(0,160) || 'Keepwork MCP client' }, controller.signal);
            controller.signal.throwIfAborted();
            if (revision !== this.revision) throw Error('Screenshot permission changed; request again');
            if (choice === 'cancel') throw Error('Screenshot permission denied');
            if (choice === 'always') this.write(true);
            else if (choice !== 'once') throw Error('Invalid screenshot permission choice');
        } finally { signal?.removeEventListener('abort', abort); this.pending = undefined; }
    }
}

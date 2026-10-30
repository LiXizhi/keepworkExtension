import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const ID = /^[\w-]{1,160}$/;
const TEXT_LIMIT = 2_000_000;
/** Read only native project transcripts, never settings, credentials or nested agent logs. */
export class NativeCliHistory {
    private catalog?: {at:number; data:any[]};
    private files = new Map<string, string>();
    constructor(private backend: 'claude' | 'workbuddy' | 'codebuddy', private root?: string) {}
    private directory() {
        const home = this.backend === 'claude' ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
            : process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy');
        return this.root || path.join(home, 'projects');
    }
    private async rows(file: string, tail = false) {
        const handle = await fs.open(file, 'r');
        try {
            const stat = await handle.stat();
            const size = Math.min(stat.size, tail ? TEXT_LIMIT : 65536), start = tail ? stat.size - size : 0;
            const buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, start);
            const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift();
            const rows: any[] = [];
            for (const line of lines) { try { rows.push(JSON.parse(line)); } catch { /* Partial or damaged record. */ } }
            return {rows, updatedAt: stat.mtimeMs / 1000, truncated: stat.size > size};
        } finally { await handle.close(); }
    }
    private text(row: any) {
        const content = row.message?.content ?? row.content;
        return typeof content === 'string' ? content : Array.isArray(content)
            ? content.filter(p => ['text','input_text','output_text'].includes(p?.type)).map(p => p.text || '').join('\n') : '';
    }
    async list(cursor?: string) {
        const offset = Number(cursor || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw Error('Invalid native history cursor');
        if (this.catalog && (offset > 0 || Date.now()-this.catalog.at < 15000)) {
            const data=this.catalog.data; return {data:data.slice(offset,offset+100),nextCursor:offset+100<data.length?String(offset+100):null};
        }
        const root = this.directory(), candidates: {file: string; id: string; mtime: number}[] = [];
        const projects = await fs.readdir(root, {withFileTypes:true}).catch(() => []);
        for (const project of projects.filter(p => p.isDirectory()).slice(0, 1000)) {
            const directory = path.join(root, project.name);
            const entries = await fs.readdir(directory, {withFileTypes:true}).catch(() => []);
            for (const entry of entries) {
                const id = entry.name.slice(0,-6);
                if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !ID.test(id) || id.startsWith('agent-')) continue;
                const file = path.join(directory,entry.name), stat = await fs.stat(file).catch(() => null);
                if (stat) candidates.push({file,id,mtime:stat.mtimeMs});
            }
        }
        const canonical = await fs.realpath(root).catch(()=>null);
        candidates.sort((a,b)=>b.mtime-a.mtime || a.id.localeCompare(b.id));
        this.files.clear(); const data: any[] = [];
        for (const candidate of candidates.slice(0,1000)) {
            if (this.files.has(candidate.id)) continue;
            try {
                const real = await fs.realpath(candidate.file);
                if (!canonical || !real.startsWith(canonical+path.sep)) continue;
                const {rows,updatedAt} = await this.rows(real);
                const metadata = rows.find(r => r.sessionId === candidate.id && typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && !r.isSidechain);
                if (!metadata) continue;
                const user = rows.find(r => (r.role || r.type) === 'user' && !r.isMeta && !r.isSidechain);
                const title = rows.find(r => r.type === 'custom-title')?.customTitle || this.text(user || {}) || this.backend;
                this.files.set(candidate.id,candidate.file);
                data.push({id:candidate.id,cwd:metadata.cwd,name:String(title).slice(0,160),updatedAt});
            } catch { /* One unreadable transcript must not hide other sessions. */ }
        }
        this.catalog={at:Date.now(),data};
        return {data:data.slice(offset,offset+100),nextCursor:offset+100<data.length?String(offset+100):null};
    }
    async read(id: string) {
        if (!ID.test(id)) throw Error('Invalid native session ID');
        if (!this.files.has(id)) await this.list();
        const file = this.files.get(id); if (!file) throw Error('Native session unavailable');
        // Revalidate confinement on every read; transcript files may change after listing.
        const root = await fs.realpath(this.directory()), real = await fs.realpath(file);
        if (!real.startsWith(root + path.sep)) throw Error('Native transcript outside history directory');
        const head = await this.rows(real), tail = await this.rows(real,true);
        const metadata = head.rows.find(r => r.sessionId === id && typeof r.cwd === 'string' && path.isAbsolute(r.cwd) && !r.isSidechain);
        if (!metadata) throw Error('Native session metadata unavailable');
        const items: any[] = [];
        for (const row of tail.rows) {
            if (row.isSidechain || row.isMeta || (row.sessionId && row.sessionId !== id)) continue;
            const role = row.message?.role || row.role || row.type, text = this.text(row);
            if (!['user','assistant'].includes(role) || !text) continue;
            items.push(role === 'user' ? {id:row.uuid || row.id || `history-${items.length}`,type:'userMessage',content:[{type:'text',text}]}
                : {id:row.uuid || row.id || `history-${items.length}`,type:'agentMessage',text});
        }
        const user = head.rows.find(r => (r.role || r.type) === 'user' && !r.isMeta && !r.isSidechain);
        return {id,cwd:metadata.cwd,name:this.text(user || {}).slice(0,160) || this.backend,updatedAt:tail.updatedAt,turns:[{items:items.slice(-2000)}],truncated:tail.truncated};
    }
}

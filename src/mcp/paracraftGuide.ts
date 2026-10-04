import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const prefix = 'keepwork://skills/paracraft-create/';

function creationGuideRoot(): string {
    const roots = [path.join(__dirname, 'skills/paracraft-create'), path.resolve(__dirname, '../../skills/paracraft-create')];
    const root = roots.find(candidate => fs.existsSync(path.join(candidate, 'SKILL.md')));
    if (!root) throw new Error('Paracraft creation skill is missing from this package; rebuild or update Keepwork.');
    return root;
}

/** Enumerate for package/link audits only; runtime reads never load the catalog. */
export function loadCreationGuide(): Map<string, string> {
    const root = creationGuideRoot();
    const files = new Map<string, string>();
    const walk = (directory: string, relative = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const name = relative + entry.name;
            if (entry.isDirectory()) walk(path.join(directory, entry.name), name + '/');
            else if (entry.isFile() && /\.(md|lua|yaml)$/.test(entry.name)) {
                const text = fs.readFileSync(path.join(directory, entry.name), 'utf8');
                if (Buffer.byteLength(text) > 131072) throw new Error(`Oversized creation guide: ${name}`);
                files.set(name, text);
            }
        }
    };
    walk(root);
    return files;
}

export function readCreationGuide(file = 'SKILL.md') {
    const unknown = () => new Error('unknown_guide: read SKILL.md and follow its relative reference paths');
    // Relative packaged paths only. Do not normalize traversal into a valid name.
    if (typeof file !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*\.(md|lua|yaml)$/.test(file)
        || file.split('/').some(segment => segment === '.' || segment === '..')) throw unknown();
    const root = fs.realpathSync(creationGuideRoot());
    let target: string;
    try { target = fs.realpathSync(path.join(root, file)); } catch { throw unknown(); }
    const relative = path.relative(root, target);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw unknown();
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw unknown();
    if (stat.size > 131072) throw new Error(`Oversized creation guide: ${file}`);
    const content = fs.readFileSync(target, 'utf8');
    if (Buffer.byteLength(content) > 131072) throw new Error(`Oversized creation guide: ${file}`);
    return { path: file, content };
}

export function registerCreationGuide(server: McpServer) {
    // Only the root skill is advertised. References are fetched through the CLI on demand.
    server.registerResource('paracraft-create', prefix + 'SKILL.md', {
        description: 'Create editable voxel scenes and animated assets. Load supporting guidance through paracraft_cli only when needed.',
        mimeType: 'text/markdown',
    }, async uri => ({ contents: [{ uri: uri.href, text: readCreationGuide().content, mimeType: 'text/markdown' }] }));
}

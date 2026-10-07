import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureMcpHome, mcpHomeDir } from './config';

export type ModelBridge = { port: number; pid: number; token: string };
export type EditorModel = { id: string; name: string; vendor: string; maxInputTokens: number };
const bridgePath = () => path.join(mcpHomeDir(), 'model-bridge.json');
export function readModelBridge(): ModelBridge | undefined {
    try {
        const info = JSON.parse(fs.readFileSync(bridgePath(), 'utf8'));
        if (Number.isInteger(info.port) && info.port > 0 && info.port <= 65535 && Number.isInteger(info.pid)
            && typeof info.token === 'string' && /^[a-f0-9]{48}$/.test(info.token)) return info;
    } catch { /* optional editor */ }
}
export function writeModelBridge(info: ModelBridge) {
    ensureMcpHome();
    fs.writeFileSync(bridgePath(), JSON.stringify(info), { mode: 0o600 });
}
export function clearModelBridge(token: string) {
    if (readModelBridge()?.token === token) try { fs.unlinkSync(bridgePath()); } catch { /* closed */ }
}
export async function editorModels(): Promise<{ bridge?: ModelBridge; models: EditorModel[] }> {
    const bridge = readModelBridge();
    if (!bridge) return { models: [] };
    try {
        const response = await fetch(`http://127.0.0.1:${bridge.port}/models`, {
            headers: { Authorization: `Bearer ${bridge.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error',
        });
        if (!response.ok) return { models: [] };
        const body: any = await response.json();
        const models = Array.isArray(body.models) ? body.models.slice(0, 200).filter((m: any) =>
            typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 500 && typeof m.name === 'string'
            && typeof m.vendor === 'string' && m.vendor.toLowerCase() !== 'copilot'
            && Number.isInteger(m.maxInputTokens) && m.maxInputTokens > 0).map((m: EditorModel) =>
            ({ id: m.id, name: m.name.slice(0, 200), vendor: m.vendor.slice(0, 100), maxInputTokens: m.maxInputTokens })) : [];
        return { bridge, models };
    } catch { return { models: [] }; }
}

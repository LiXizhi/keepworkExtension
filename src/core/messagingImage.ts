import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const replyImageCapability = {
    version: 1, transport: 'file', maxBytes: 5 * 1024 * 1024,
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
} as const;
export interface ReplyImageMetadata { name: string; mimeType: string; size: number; sha256: string; transport: 'file' }
export interface ReplyImage { bytes: Buffer; extension: string; metadata: ReplyImageMetadata }

/** Only bytes enter this API. Client filenames are display metadata, never disk paths. */
export function parseReplyImage(input: unknown): ReplyImage {
    const image = input as Record<string, unknown> | null;
    if (!image || typeof image !== 'object' || Array.isArray(image) ||
        Object.keys(image).some(key => !['name', 'mimeType', 'base64'].includes(key))) throw Error('Invalid image payload');
    const { name, mimeType, base64 } = image;
    if (typeof name !== 'string' || !name.trim() || [...name].length > 160 || name === '.' || name === '..' ||
        /[\x00-\x1f\x7f-\x9f/\\:<>"|?*]/.test(name) || typeof mimeType !== 'string' ||
        !replyImageCapability.mimeTypes.includes(mimeType as typeof replyImageCapability.mimeTypes[number])) {
        throw Error('请选择 PNG、JPEG、GIF 或 WebP 图片，文件名不能包含路径');
    }
    if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(replyImageCapability.maxBytes / 3) * 4) {
        throw Error('图片不能为空且不能超过 5 MiB');
    }
    // Buffer.from accepts whitespace, URL-safe characters and truncated padding; this API does not.
    if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw Error('图片数据无效');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > replyImageCapability.maxBytes) throw Error('图片不能为空且不能超过 5 MiB');
    if (bytes.toString('base64') !== base64) throw Error('图片数据无效');
    let extension = '';
    if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') extension = 'png';
    else if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) extension = 'jpg';
    else if (mimeType === 'image/gif' && bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) extension = 'gif';
    else if (mimeType === 'image/webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
    if (!extension) throw Error('图片内容与类型不符或图片已损坏');
    return { bytes, extension, metadata: { name, mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), transport: 'file' } };
}

export function stageReplyImage(root: string, image: ReplyImage): { relative: string; cleanup: () => void } {
    let directory = '';
    try {
        directory = fs.mkdtempSync(path.join(root, '.keepwork-reply-'));
        fs.chmodSync(directory, 0o700);
        // Fixed basename also avoids Windows reserved client filenames such as CON.png.
        const filename = `image.${image.extension}`;
        fs.writeFileSync(path.join(directory, filename), image.bytes, { mode: 0o600, flag: 'wx' });
        return { relative: `${path.basename(directory)}/${filename}`, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
    } catch {
        if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* no external mutation */ } }
        throw Error('无法准备图片附件，请检查工作目录权限');
    }
}

/** Refuse a remote mutation until its no-replay record is durably written. */
export function saveReplyImageLedger(home: string, inbox: unknown): void {
    const temporary = path.join(home, `inbox-image-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(inbox));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporary, path.join(home, 'inbox.json'));
    } catch { throw Error('无法保存发送状态，图片尚未发送'); }
    finally {
        if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* preserve original failure */ } }
        try { fs.unlinkSync(temporary); } catch { /* renamed or unavailable */ }
    }
}

export function imageSendReceipt(value: any, depth = 0): boolean {
    return depth <= 8 && receiptConfirmed(value) && (
        ['openTaskId', 'openMessageId', 'messageId'].some(key => typeof value[key] === 'string' && value[key].trim()) ||
        ['result', 'data'].some(key => imageSendReceipt(value[key], depth + 1)));
}

function receiptConfirmed(value:any):boolean {
    return !!value&&typeof value==='object'&&!Array.isArray(value)&&value.success!==false&&!value.error&&
        !['pending','sending','queued','processing','failed','failure','cancelled','canceled','rejected'].includes(String(value.status||value.state||'').toLowerCase());
}
export interface ImageReceiptIds { remoteTaskId?: string; remoteMessageId?: string; remoteConversationId?: string }
/** Task IDs and message IDs occupy different namespaces. Only reviewed envelopes are traversed. */
export function imageReceiptIds(value: any, conversation: string, requireConversation = false, depth = 0, allowRemoteConversation = false): ImageReceiptIds {
    if (depth > 8 || !receiptConfirmed(value)) return {};
    const id = (key: string) => typeof value[key] === 'string' && value[key].trim() && value[key].length <= 2048 ? value[key] as string : undefined;
    const remoteTaskId = id('openTaskId');
    const cid = id('openConversationId') || id('conversationId');
    if(cid&&cid!==conversation&&!allowRemoteConversation)return remoteTaskId?{remoteTaskId}:{};
    const remoteMessageId = (!requireConversation || !!cid) ? id('openMessageId') || id('messageId') : undefined;
    const result: ImageReceiptIds = { ...(remoteTaskId ? { remoteTaskId } : {}), ...(remoteMessageId ? { remoteMessageId,...(cid&&cid!==conversation?{remoteConversationId:cid}:{}) } : {}) };
    for (const key of ['result', 'data']) {
        const nested = imageReceiptIds(value[key], conversation, requireConversation, depth + 1, allowRemoteConversation);
        if(nested.remoteTaskId)result.remoteTaskId ||= nested.remoteTaskId;
        if(!result.remoteMessageId&&nested.remoteMessageId){result.remoteMessageId=nested.remoteMessageId;if(nested.remoteConversationId)result.remoteConversationId=nested.remoteConversationId;}
    }
    return result;
}

/** Keep the local request identity and preview; only a verified outgoing remote ID can collapse an echo. */
export function coalesceImageEchoes<T extends { id: string; conversation: string; direction: string; state?: string; remoteEvent?: boolean; image?: unknown; remoteMessageId?: string; remoteConversationId?: string }>(messages: T[]): T[] {
    const aliases = new Set(messages.filter(row => row.direction === 'out' && row.image && row.remoteMessageId)
        .flatMap(row => [JSON.stringify([row.conversation, row.remoteMessageId]),JSON.stringify([row.remoteConversationId||row.conversation,row.remoteMessageId]) ]));
    return messages.filter(row => row.direction !== 'out' || !!row.image || !(['synced','recovered'].includes(row.state||'')||row.remoteEvent===true) || !aliases.has(JSON.stringify([row.conversation, row.id])));
}

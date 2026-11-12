type Item = { id: string; type: string; [key: string]: any };
const TEXT_LIMIT = 131072;
const partText = (part: any): string => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '';
const joinedParts = (parts: any): string => Array.isArray(parts)
    ? parts.slice(0, 2000).map(partText).filter(Boolean).join('\n\n').slice(-TEXT_LIMIT) : '';
function boundParts(parts: any[]) {
    let remaining = TEXT_LIMIT;
    for (let index = parts.length - 1; index >= 0; index--) {
        const text = partText(parts[index]);
        if (text.length > remaining) {
            const bounded = remaining ? text.slice(-remaining) : '';
            parts[index] = typeof parts[index] === 'object' && parts[index] !== null ? { ...parts[index], text: bounded } : bounded;
        }
        remaining = Math.max(0, remaining - text.length);
    }
}

/** Keep native reasoning fields and add the legacy text consumed by AIChat. */
export function visibleReasoning(item: any) {
    if (item?.type !== 'reasoning') return item;
    const text = joinedParts(item.summary) || joinedParts(item.content);
    return text ? { ...item, text } : item;
}

const empty = (value: any) => value == null || value === '' || (Array.isArray(value) && !value.some(part => partText(part)));
export function mergeStreamItem(previous: Item | undefined, incoming: Item): Item {
    const item = { ...previous, ...incoming };
    const nativeText = incoming.type === 'reasoning' ? joinedParts(incoming.summary) || joinedParts(incoming.content) : '';
    // Some adapters emit an empty started/completed shell after the deltas.
    // A nonempty final snapshot remains authoritative, including rewritten plans.
    for (const key of ['text', 'aggregatedOutput', 'summary', 'content']) {
        if (item.type !== 'reasoning' && (key === 'summary' || key === 'content')) continue;
        if (nativeText && (key === 'summary' || key === 'content')) continue;
        if (empty(incoming[key]) && !empty(previous?.[key])) item[key] = previous![key];
    }
    if (nativeText) return { ...item, text: nativeText };
    if (incoming.type === 'reasoning' && typeof incoming.text === 'string' && incoming.text) return item;
    return visibleReasoning(item);
}

export function isItemDelta(method: string) {
    return method.endsWith('/delta') || method.endsWith('/outputDelta')
        || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta';
}

/** Only known native events can create an item when started is absent/late. */
export function applyItemDelta(items: Item[], method: string, params: any) {
    if (typeof params.itemId !== 'string' || !params.itemId) return;
    let item = items.find(item => item.id === params.itemId);
    if (!item) {
        const type = ({
            'item/agentMessage/delta': 'agentMessage', 'item/plan/delta': 'plan',
            'item/reasoning/summaryTextDelta': 'reasoning', 'item/reasoning/textDelta': 'reasoning',
            'item/reasoning/summaryPartAdded': 'reasoning',
            'item/commandExecution/outputDelta': 'commandExecution',
        } as Record<string, string>)[method];
        if (!type) return;
        item = { id: params.itemId, type }; items.push(item);
    }
    if (method.startsWith('item/reasoning/')) {
        const summary = method !== 'item/reasoning/textDelta';
        const key = summary ? 'summary' : 'content';
        const index = params[summary ? 'summaryIndex' : 'contentIndex'] ?? 0;
        if (!Number.isSafeInteger(index) || index < 0 || index >= 2000) return;
        const parts = Array.isArray(item[key]) ? item[key] : (item[key] = []);
        while (parts.length <= index) parts.push('');
        if (typeof params.delta === 'string') {
            const text = (partText(parts[index]) + params.delta).slice(-TEXT_LIMIT);
            parts[index] = typeof parts[index] === 'object' && parts[index] !== null ? { ...parts[index], text } : text;
        }
        boundParts(parts);
        Object.assign(item, visibleReasoning(item));
    } else if (typeof params.delta === 'string') {
        const key = item.type === 'commandExecution' ? 'aggregatedOutput' : 'text';
        item[key] = String((item[key] || '') + params.delta).slice(-TEXT_LIMIT);
    }
}

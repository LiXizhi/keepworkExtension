"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoverTextToolCalls = recoverTextToolCalls;
/** Compatibility for completed model replies that serialize calls as XML text. */
const MAX_TEXT = 1024 * 1024, MAX_CALLS = 32;
const inert = text => text.replace(/[^\r\n]/g, ' ');
function executableText(text) {
    // Mask examples without changing offsets into the original response.
    let fence = null;
    const masked = text.replace(/<!--[\s\S]*?(?:-->|$)/g, inert).split('\n').map(line => {
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
                && !line.slice(marker[0].length).trim())
                fence = null;
            return inert(line);
        }
        if (marker) {
            fence = marker[1];
            return inert(line);
        }
        return /^(?: {0,3}>| {4}|\t)/.test(line) ? inert(line) : line;
    }).join('\n');
    return masked.replace(/(`+)[\s\S]*?\1/g, inert);
}
function fields(text) {
    const entries = [];
    let rest = text.trim();
    while (rest) {
        const match = /^<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/.exec(rest);
        if (!match || entries.some(([name]) => name === match[1]))
            throw Error('Malformed or duplicate XML tool field');
        entries.push([match[1], match[2]]);
        rest = rest.slice(match[0].length).trim();
    }
    return entries;
}
function xmlValue(text) {
    if (text.startsWith('<![CDATA[') && text.endsWith(']]>'))
        return text.slice(9, -3);
    if (/<\/?[A-Za-z_!]/.test(text))
        throw Error('Nested XML tool arguments are unsupported');
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name) => {
        if (name[0] !== '#')
            return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()];
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
            throw Error('Invalid XML entity');
        return String.fromCodePoint(code);
    });
}
function argumentValue(text, schema = {}) {
    const value = xmlValue(!schema.type || schema.type === 'string' ? text : text.trim());
    // Unknown fields stay strings so validation can report their actual names.
    if (!schema.type || schema.type === 'string')
        return value;
    if (schema.type === 'boolean' && /^(true|false)$/i.test(value))
        return value.toLowerCase() === 'true';
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function validate(value, schema, field = 'arguments') {
    if (!schema || typeof schema !== 'object')
        throw Error(`${field}: missing argument schema`);
    const supported = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'minimum', 'maximum',
        'minItems', 'maxItems', 'minLength', 'maxLength', 'additionalProperties', 'description', 'title', 'default', 'examples', '$schema']);
    if (Object.keys(schema).some(key => !supported.has(key)) || Array.isArray(schema.type)
        || (!schema.type && ['properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength'].some(key => Object.hasOwn(schema, key)))
        || (schema.additionalProperties && typeof schema.additionalProperties === 'object')) {
        throw Error(`${field}: this schema requires native structured tool calls`);
    }
    const type = schema.type;
    const valid = !type || (type === 'null' ? value === null
        : type === 'array' ? Array.isArray(value)
            : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
                : type === 'integer' ? Number.isSafeInteger(value)
                    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
                        : typeof value === type);
    if (!valid)
        throw Error(`${field}: expected ${type}`);
    if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
        throw Error(`${field}: value is not in enum`);
    if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const))
        throw Error(`${field}: unexpected constant`);
    if (type === 'object') {
        for (const name of schema.required || []) {
            if (!Object.hasOwn(value, name))
                throw Error(`${field}: missing required property ${name}`);
        }
        for (const [name, child] of Object.entries(value)) {
            if (!Object.hasOwn(schema.properties || {}, name))
                throw Error(`${field}: unknown property ${name}`);
            validate(child, schema.properties[name], `${field}.${name}`);
        }
    }
    if (type === 'array') {
        if (!schema.items && value.length)
            throw Error(`${field}: missing array item schema`);
        for (const item of value)
            validate(item, schema.items, `${field}[]`);
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity))
            throw Error(`${field}: array size out of range`);
    }
    if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)))
        throw Error(`${field}: number out of range`);
    if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)))
        throw Error(`${field}: string size out of range`);
}
function recoverTextToolCalls(content, tools, iteration) {
    if (typeof content !== 'string' || content.length > MAX_TEXT || !tools?.length || !content.includes('<tool_calls>'))
        return null;
    const visible = executableText(content), ranges = [], calls = [], errors = new Map();
    const starts = /<tool_calls\b/g;
    let start;
    try {
        while ((start = starts.exec(visible))) {
            const prefix = visible.slice(visible.lastIndexOf('\n', start.index - 1) + 1, start.index);
            if (prefix.trim() && !/^(?: *<\/tool_calls> *)+$/.test(prefix))
                continue;
            if (!visible.startsWith('<tool_calls>', start.index))
                return null;
            const end = visible.indexOf('</tool_calls>', starts.lastIndex);
            if (end < 0)
                return null;
            const block = content.slice(start.index + 12, end);
            let remaining = block.trim();
            if (!remaining)
                return null;
            while (remaining) {
                const tool = /^<tool>([\s\S]*?)<\/tool>/.exec(remaining);
                if (!tool || calls.length >= MAX_CALLS)
                    return null;
                const entries = fields(tool[1]);
                const nameEntry = entries.find(([name]) => name === 'tool_name');
                if (!nameEntry)
                    return null;
                const name = xmlValue(nameEntry[1].trim());
                const definition = tools.find(item => item.function?.name === name)?.function;
                const args = Object.fromEntries(entries.filter(([key]) => key !== 'tool_name').map(([key, value]) => [key, argumentValue(value, definition?.parameters?.properties?.[key])]));
                const id = `text-call-${iteration}-${calls.length}`;
                calls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
                if (definition) {
                    try {
                        validate(args, definition.parameters);
                    }
                    catch (error) {
                        const parameters = definition.parameters || {};
                        errors.set(id, `Invalid recovered tool arguments: ${error.message}. Use the advertised schema: ${JSON.stringify(parameters).slice(0, 4096)}`);
                    }
                }
                remaining = remaining.slice(tool[0].length).trim();
            }
            const after = end + 13;
            ranges.push([start.index, after]);
            starts.lastIndex = after;
        }
    }
    catch {
        return null;
    }
    if (!calls.length)
        return null;
    let cleaned = '', cursor = 0;
    for (const [begin, end] of ranges) {
        cleaned += content.slice(cursor, begin);
        cursor = end;
    }
    cleaned += content.slice(cursor);
    return { content: cleaned.trim(), calls, errors };
}

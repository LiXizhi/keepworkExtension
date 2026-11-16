"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recoverTextToolCalls = recoverTextToolCalls;
/** Compatibility for completed model replies that serialize calls as XML text. */
const MAX_TEXT = 1024 * 1024, MAX_CALLS = 32;
const inert = text => text.replace(/[^\r\n]/g, ' ');
const maskXmlLiterals = text => text.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, inert);
function maskRanges(text, ranges) {
    let masked = '', cursor = 0;
    for (const [begin, end] of ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
        if (begin < cursor)
            continue;
        masked += text.slice(cursor, begin) + inert(text.slice(begin, end));
        cursor = end;
    }
    return masked + text.slice(cursor);
}
function maskLinks(text) {
    const ranges = [], labels = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
            continue;
        }
        if (text[i] === '[')
            labels.push(i);
        else if (text[i] === ']' && labels.length) {
            const begin = labels.pop();
            let target = i + 1;
            while (text[target] === ' ' || text[target] === '\t')
                target++;
            const open = text[target], close = open === '(' ? ')' : ']';
            if (open !== '(' && open !== '[')
                continue;
            let depth = 1, end = target + 1;
            for (; end < text.length && depth; end++) {
                if (text[end] === '\\')
                    end++;
                else if (text[end] === open)
                    depth++;
                else if (text[end] === close)
                    depth--;
            }
            ranges.push([begin, end]);
            i = end - 1;
            if (depth)
                break; // An unfinished target masks its tail once.
        }
    }
    return maskRanges(text, ranges);
}
function maskHtml(text) {
    const containers = new Set(['pre', 'code', 'script', 'style', 'textarea', 'template', 'xmp', 'blockquote', 'q']);
    const rawText = new Set(['script', 'style', 'textarea', 'xmp']);
    const tags = /<\/?([A-Za-z][\w:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/g;
    const ranges = [], stack = [];
    let tag, begin;
    while ((tag = tags.exec(text))) {
        const name = tag[1].toLowerCase(), closing = tag[0].startsWith('</');
        if (stack.length) {
            if (closing && name === stack.at(-1)) {
                stack.pop();
                if (!stack.length)
                    ranges.push([begin, tags.lastIndex]);
            }
            else if (!closing && containers.has(name) && !rawText.has(stack.at(-1)))
                stack.push(name);
        }
        else if (!closing && containers.has(name)) {
            begin = tag.index;
            stack.push(name);
        }
        else if (!['tool_calls', 'seed:tool_call'].includes(tag[1]))
            ranges.push([tag.index, tags.lastIndex]);
    }
    if (stack.length)
        ranges.push([begin, text.length]);
    return maskRanges(text, ranges);
}
function executableText(text) {
    // Mask examples without changing offsets into the original response.
    let fence = null;
    const masked = text.split('\n').map(line => {
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
    const codeMasked = masked.replace(/(`+)[\s\S]*?\1/g, inert);
    const definitionsMasked = codeMasked.replace(/^ {0,3}\[(?:\\.|[^\]\\\n])+\]:[^\n]*(?:\n[ \t]+[^\n]*)*/gm, inert);
    return maskLinks(maskHtml(definitionsMasked));
}
function fields(text) {
    const entries = [];
    let rest = text.trim();
    while (rest) {
        const match = /^<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/.exec(maskXmlLiterals(rest));
        if (!match || entries.some(([name]) => name === match[1]))
            throw Error('Malformed or duplicate XML tool field');
        entries.push([match[1], rest.slice(match[1].length + 2, match[0].length - match[1].length - 3)]);
        rest = rest.slice(match[0].length).trim();
    }
    return entries;
}
function attributes(text, allowed) {
    const result = Object.create(null);
    let rest = text;
    while (rest.trim()) {
        const match = /^\s+([A-Za-z_][\w.-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(rest);
        if (!match || !allowed.includes(match[1]) || Object.hasOwn(result, match[1]))
            throw Error('Unsupported or duplicate XML tool attribute');
        result[match[1]] = xmlValue(match[3]);
        rest = rest.slice(match[0].length);
    }
    if (!result.name)
        throw Error('Missing XML tool name');
    return result;
}
function seedFields(text) {
    const entries = [];
    let rest = text.trim();
    while (rest) {
        const match = /^<parameter(\s[^>]*?)?>([\s\S]*?)<\/parameter>/.exec(maskXmlLiterals(rest));
        if (!match)
            throw Error('Malformed Seed tool parameter');
        const attrs = attributes(match[1] || '', ['name', 'string']);
        if (entries.some(([name]) => name === attrs.name) || (attrs.string !== undefined && !['true', 'false'].includes(attrs.string))) {
            throw Error('Duplicate Seed parameter or invalid string flag');
        }
        entries.push([attrs.name, rest.slice(match[0].indexOf('>') + 1, match[0].length - '</parameter>'.length), attrs.string]);
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
function argumentValue(text, schema = {}, stringFlag) {
    // Seed's explicit string flag controls serialization; schema still validates
    // the result. Never coerce a declared string merely to make a call pass.
    if (stringFlag === 'true')
        return xmlValue(text);
    if (stringFlag === 'false')
        return JSON.parse(xmlValue(text.trim()));
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
    if (typeof content !== 'string' || content.length > MAX_TEXT || !tools?.length || !/<(?:tool_calls|seed:tool_call)>/.test(content))
        return null;
    const literalMasked = maskXmlLiterals(content), visible = executableText(literalMasked), ranges = [], calls = [], errors = new Map();
    const starts = /<(tool_calls|seed:tool_call)\b/g;
    let start;
    try {
        while ((start = starts.exec(visible))) {
            // Explicit wrappers may follow ordinary prose on the same line.
            // Example contexts are masked above rather than guessed from prose.
            const open = `<${start[1]}>`, close = `</${start[1]}>`, seed = start[1] === 'seed:tool_call';
            if (!visible.startsWith(open, start.index))
                return null;
            // Argument text may contain Markdown/HTML examples. Its original
            // closing wrapper still ends the call; CDATA and comments do not.
            const end = literalMasked.indexOf(close, starts.lastIndex);
            if (end < 0)
                return null;
            const block = content.slice(start.index + open.length, end);
            let remaining = block.trim();
            if (!remaining)
                return null;
            while (remaining) {
                const structural = maskXmlLiterals(remaining);
                const tool = seed ? /^<function(\s[^>]*?)?>([\s\S]*?)<\/function>/.exec(structural) : /^<tool>([\s\S]*?)<\/tool>/.exec(structural);
                if (!tool || calls.length >= MAX_CALLS)
                    return null;
                const body = remaining.slice(tool[0].indexOf('>') + 1, tool[0].length - (seed ? '</function>' : '</tool>').length);
                let name, entries;
                if (seed) {
                    name = attributes(tool[1] || '', ['name']).name;
                    entries = seedFields(body);
                }
                else {
                    const values = fields(body), nameEntry = values.find(([key]) => key === 'tool_name');
                    if (!nameEntry)
                        return null;
                    name = xmlValue(nameEntry[1].trim());
                    entries = values.filter(([key]) => key !== 'tool_name');
                }
                const definition = tools.find(item => item.function?.name === name)?.function;
                const args = Object.fromEntries(entries.map(([key, value, stringFlag]) => [key, argumentValue(value, definition?.parameters?.properties?.[key], stringFlag)]));
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
            const after = end + close.length;
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

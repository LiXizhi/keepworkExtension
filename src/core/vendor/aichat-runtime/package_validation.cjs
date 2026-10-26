"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = exports.BASE_VERSION = exports.HOST_API_VERSION = void 0;
exports.assertId = assertId;
exports.safePath = safePath;
exports.compatible = compatible;
exports.validateManifest = validateManifest;
exports.mergeConfig = mergeConfig;
exports.validateConfig = validateConfig;
exports.validatePortableConfig = validatePortableConfig;
exports.readPath = readPath;
exports.configLeaves = configLeaves;
const package_schema_cjs_1 = require("./package_schema.cjs");
// Public, environment-independent package/profile API. No application imports.
exports.HOST_API_VERSION = '1.0.0';
exports.BASE_VERSION = '1.0.0';
const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
exports.VERSION = /^\d+\.\d+\.\d+$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function assertId(id) { if (typeof id !== 'string' || !ID.test(id))
    throw Error(`Invalid ID: ${id}`); return id; }
function safePath(value) {
    if (typeof value !== 'string' || !value || /[\\:%?#\x00-\x1f]/.test(value)
        || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
        || ['__proto__', 'constructor', 'prototype'].includes(p)))
        throw Error(`Invalid package path: ${value}`);
    return value;
}
function compatible(version, range) {
    if (!exports.VERSION.test(version || '') || typeof range !== 'string')
        return false;
    if (range === version)
        return true;
    if (!range.startsWith('^') || !exports.VERSION.test(range.slice(1)))
        return false;
    const a = version.split('.').map(Number), b = range.slice(1).split('.').map(Number);
    return a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] >= b[2]);
}
function validateManifest(m) {
    validateConfig(package_schema_cjs_1.PACKAGE_SCHEMA, m, 'manifest');
    if (!m || m.schemaVersion !== 1)
        throw Error('Unsupported package schema');
    assertId(m.id);
    if (m.assetLayout && !['legacy', 'isolated'].includes(m.assetLayout))
        throw Error('Invalid asset layout');
    for (const [name, version] of Object.entries(m.requiresServices || {})) {
        if (!/^[a-z][a-z0-9:._-]*$/i.test(name) || !/^\^?\d+\.\d+\.\d+$/.test(version))
            throw Error('Invalid service requirement');
    }
    if (!exports.VERSION.test(m.version || '') || !compatible(exports.HOST_API_VERSION, m.hostApi))
        throw Error(`Incompatible package: ${m.id}`);
    if (!Array.isArray(m.files) || m.files.length > 10000 || new Set(m.files.map(file => String(file).toLowerCase())).size !== m.files.length)
        throw Error('files must be unique and bounded');
    m.files.forEach(safePath);
    for (const [id, range] of Object.entries(m.dependencies || {})) {
        assertId(id);
        if (!/^\^?\d+\.\d+\.\d+$/.test(range))
            throw Error(`Invalid dependency range: ${id}`);
    }
    for (const kind of ['tools', 'skills', 'panels', 'skins']) {
        const ids = new Set();
        for (const row of m.contributes?.[kind] || []) {
            if (typeof row.id !== 'string' || !row.id || ids.has(row.id.toLowerCase()))
                throw Error(`Duplicate ${kind} ID`);
            ids.add(row.id.toLowerCase());
        }
    }
    if (!Array.isArray(m.capabilities) || m.capabilities.some(c => typeof c !== 'string'))
        throw Error('Invalid capabilities');
    for (const entry of Object.values(m.entrypoints || {})) {
        safePath(entry);
        if (!m.files.includes(entry))
            throw Error(`Entry not inventoried: ${entry}`);
    }
    return m;
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function mergeConfig(base = {}, patch = {}) {
    if (!object(base) || !object(patch))
        throw Error('Configuration must be an object');
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(patch)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
            throw Error('Unsafe configuration key');
        result[key] = object(value) ? mergeConfig(object(result[key]) ? result[key] : {}, value) : structuredClone(value);
    }
    return result;
}
function validateConfig(schema = {}, value, at = 'config') {
    const type = schema.type;
    if (type && !(type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
        : type === 'integer' ? Number.isInteger(value) : typeof value === type))
        throw Error(`${at}: expected ${type}`);
    if (schema.const !== undefined && value !== schema.const)
        throw Error(`${at}: expected ${schema.const}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum))
        throw Error(`${at}: outside allowed range`);
    if (typeof value === 'string' && (schema.minLength !== undefined && value.length < schema.minLength || schema.pattern && !new RegExp(schema.pattern).test(value)))
        throw Error(`${at}: invalid value`);
    if (Array.isArray(value) && schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length)
        throw Error(`${at}: duplicate values`);
    if (schema.enum && !schema.enum.includes(value))
        throw Error(`${at}: unsupported value`);
    if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength)
        throw Error(`${at}: too long`);
    if (object(value)) {
        for (const key of schema.required || [])
            if (!own(value, key))
                throw Error(`${at}.${key}: required`);
        for (const [key, item] of Object.entries(value)) {
            if (schema.additionalProperties === false && !own(schema.properties || {}, key))
                throw Error(`${at}.${key}: unknown setting`);
            if (schema.properties?.[key])
                validateConfig(schema.properties[key], item, `${at}.${key}`);
            else if (object(schema.additionalProperties))
                validateConfig(schema.additionalProperties, item, `${at}.${key}`);
        }
    }
    if (Array.isArray(value) && schema.items)
        value.forEach((item, i) => validateConfig(schema.items, item, `${at}[${i}]`));
    return value;
}
function validatePortableConfig(value) {
    if (!object(value))
        return;
    for (const [key, item] of Object.entries(value)) {
        if (/^(?:apiKey|token|accessToken|refreshToken|password|clientSecret|privateKey)$/i.test(key))
            throw Error(`Credentials cannot be stored in profiles: ${key}`);
        if (object(item))
            validatePortableConfig(item);
        if (Array.isArray(item))
            item.forEach(validatePortableConfig);
        if (typeof item === 'string' && /^(?:endpoint|gateway|baseURL|profileURL|entryURL)$/i.test(key)) {
            const url = new URL(item);
            if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|key|secret/i.test(k)))
                throw Error(`Credential-bearing endpoint: ${key}`);
            if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
                throw Error(`Endpoint requires HTTPS or loopback HTTP: ${key}`);
        }
    }
}
function readPath(o, path) {
    if (!object(o))
        return undefined;
    if (own(o, path))
        return o[path];
    for (const key of Object.keys(o).sort((a, b) => b.length - a.length))
        if (path.startsWith(key + '.'))
            return readPath(o[key], path.slice(key.length + 1));
}
function configLeaves(value, prefix = '') {
    return Object.entries(value).flatMap(([key, item]) => {
        const name = prefix ? `${prefix}.${key}` : key;
        return object(item) && Object.keys(item).length ? configLeaves(item, name) : [name];
    });
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProfile = resolveProfile;
exports.validateComposition = validateComposition;
const package_validation_cjs_1 = require("./package_validation.cjs");
async function resolveProfile(id, load, { overrides = {}, baseVersion = package_validation_cjs_1.BASE_VERSION } = {}) {
    const stack = [], done = new Set(), ordered = [];
    async function visit(name) {
        (0, package_validation_cjs_1.assertId)(name);
        if (stack.includes(name))
            throw Error(`Profile cycle: ${[...stack, name].join(' -> ')}`);
        if (done.has(name))
            return;
        const p = await load(name);
        if (!p || p.schemaVersion !== 1 || p.id !== name)
            throw Error(`Invalid profile: ${name}`);
        if (!(0, package_validation_cjs_1.compatible)(baseVersion, p.base))
            throw Error(`Incompatible base for ${name}`);
        stack.push(name);
        for (const parent of p.extends || [])
            await visit(parent);
        stack.pop();
        done.add(name);
        ordered.push(p);
    }
    await visit(id);
    const packages = new Map(), grants = {}, sources = {}, locks = new Set();
    let config = {};
    for (const p of ordered) {
        for (const excluded of p.exclude || [])
            packages.delete((0, package_validation_cjs_1.assertId)(excluded));
        for (const row of p.packages || []) {
            (0, package_validation_cjs_1.assertId)(row.id);
            if (!package_validation_cjs_1.VERSION.test(row.version || ''))
                throw Error('Profiles must pin package versions');
            packages.set(row.id, structuredClone(row));
        }
        config = (0, package_validation_cjs_1.mergeConfig)(config, p.config || {});
        for (const key of (0, package_validation_cjs_1.configLeaves)(p.config || {}))
            sources[key] = p.id;
        for (const [key, value] of Object.entries(p.grants || {})) {
            (0, package_validation_cjs_1.assertId)(key);
            grants[key] = [...value];
        }
        for (const key of p.locks || []) {
            if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(key))
                throw Error('Invalid lock');
            locks.add(key);
        }
    }
    const effective = (0, package_validation_cjs_1.mergeConfig)(config, overrides);
    (0, package_validation_cjs_1.validatePortableConfig)(effective);
    for (const key of locks)
        if (JSON.stringify((0, package_validation_cjs_1.readPath)(effective, key)) !== JSON.stringify((0, package_validation_cjs_1.readPath)(config, key)))
            throw Error(`Managed setting: ${key}`);
    for (const key of (0, package_validation_cjs_1.configLeaves)(overrides))
        sources[key] = 'user';
    return { schemaVersion: 1, id, baseVersion, packages: [...packages.values()], config: effective, grants, locks: [...locks], sources };
}
function validateComposition(profile, manifests) {
    const byId = new Map(manifests.map(m => [(0, package_validation_cjs_1.validateManifest)(m).id, m]));
    if (byId.size !== manifests.length)
        throw Error('Duplicate package ID');
    const visiting = new Set(), visited = new Set(), order = [];
    function visit(id) {
        if (visiting.has(id))
            throw Error(`Package dependency cycle: ${id}`);
        if (visited.has(id))
            return;
        const m = byId.get(id);
        if (!m)
            throw Error(`Missing dependency: ${id}`);
        visiting.add(id);
        for (const [dep, range] of Object.entries(m.dependencies || {})) {
            if (!(0, package_validation_cjs_1.compatible)(byId.get(dep)?.version, range))
                throw Error(`Missing/incompatible dependency: ${id} -> ${dep}`);
            visit(dep);
        }
        visiting.delete(id);
        visited.add(id);
        order.push(m);
    }
    for (const p of profile.packages) {
        if (byId.get(p.id)?.version !== p.version)
            throw Error(`Missing pinned package: ${p.id}@${p.version}`);
        visit(p.id);
    }
    for (const m of order)
        (0, package_validation_cjs_1.validateConfig)(m.configSchema || {}, profile.config?.plugins?.[m.id] || {}, m.id);
    if (order.length !== manifests.length)
        throw Error('Unselected packages in composition');
    const services = new Set();
    for (const m of order)
        for (const capability of m.capabilities.filter(c => c.startsWith('service:'))) {
            if (services.has(capability))
                throw Error(`Conflicting service provider: ${capability}`);
            services.add(capability);
        }
    for (const kind of ['tools', 'skills', 'panels', 'skins']) {
        const ids = new Set();
        for (const m of order)
            for (const row of m.contributes?.[kind] || []) {
                for (const id of new Set([row.id, ...(row.aliases || [])].map(id => id.toLowerCase()))) {
                    const key = id.toLowerCase();
                    if (ids.has(key))
                        throw Error(`Conflicting ${kind} ID: ${id}`);
                    ids.add(key);
                }
            }
    }
    return order;
}

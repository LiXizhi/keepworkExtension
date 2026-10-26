"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareContributionOrder = compareContributionOrder;
exports.createRegistry = createRegistry;
const profile_resolver_cjs_1 = require("./profile_resolver.cjs");
function compareContributionOrder(a, b) {
    return (Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER) - (Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER);
}
function createRegistry(profile, manifests, baseURL, packageBaseURLs = {}) {
    const registry = { tools: [], skills: [], panels: [], skins: [], categories: [] };
    const categories = new Set();
    for (const m of (0, profile_resolver_cjs_1.validateComposition)(profile, manifests)) {
        for (const kind of ['tools', 'skills', 'panels', 'skins'])
            for (const entry of m.contributes?.[kind] || []) {
                const row = { ...entry, packageId: m.id, packageVersion: m.version, packageManaged: m.files.includes(entry.url) };
                for (const key of ['url', 'embedUrl', 'frontpage', 'localDevUrl', 'devUrl']) {
                    if (row[key])
                        row[key] = new URL(row[key], packageBaseURLs[m.id] || baseURL).href;
                }
                if (row.category)
                    categories.add(row.category);
                registry[kind].push(row);
            }
    }
    for (const kind of ['tools', 'skills', 'panels', 'skins'])
        registry[kind].sort(compareContributionOrder);
    registry.categories = [...categories];
    return registry;
}

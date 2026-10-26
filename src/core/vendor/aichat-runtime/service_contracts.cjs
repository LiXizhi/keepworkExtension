"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVICE_CONTRACTS = void 0;
exports.validateService = validateService;
exports.checkRequirements = checkRequirements;
// Authoritative runtime service vocabulary. Additive custom services remain supported.
exports.SERVICE_CONTRACTS = Object.freeze({
    model: { version: '1.0.0', methods: ['complete'] },
    identity: { version: '1.0.0', methods: ['login', 'restore', 'logout', 'onChange'] },
    storage: { version: '1.0.0', methods: ['load', 'save'] },
    workspace: { version: '1.0.0', methods: ['readFile', 'writeFile', 'listFiles'] },
    credentials: { version: '1.0.0', methods: ['get', 'set', 'delete'] },
    onboarding: { version: '1.0.0', methods: ['open'] },
    panels: { version: '1.0.0', methods: ['open'] },
});
function validateService(name, implementation) {
    const contract = exports.SERVICE_CONTRACTS[name] || (name.startsWith('tool:') ? { methods: ['execute'] } : null);
    if (contract)
        for (const method of contract.methods) {
            if (typeof implementation?.[method] !== 'function')
                throw Error(`Invalid service ${name}: missing ${method}()`);
        }
    return implementation;
}
function checkRequirements(manifest, services) {
    for (const [name, version] of Object.entries(manifest.requiresServices || {})) {
        if (!services.has(name))
            throw Error(`${manifest.id}: required service unavailable: ${name}@${version}`);
        const supported = exports.SERVICE_CONTRACTS[name]?.version;
        if (supported && version !== supported && version !== `^${supported}`)
            throw Error(`${manifest.id}: unsupported service contract: ${name}@${version}`);
        validateService(name, services.get(name));
    }
}

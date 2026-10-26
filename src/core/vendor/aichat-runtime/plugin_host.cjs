"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginHost = void 0;
const package_validation_cjs_1 = require("./package_validation.cjs");
const profile_resolver_cjs_1 = require("./profile_resolver.cjs");
const service_contracts_cjs_1 = require("./service_contracts.cjs");
class PluginHost {
    constructor(profile) { this.profile = profile; this.services = new Map(); this.active = new Map(); }
    async activate(manifest, module) {
        (0, package_validation_cjs_1.validateManifest)(manifest);
        if (this.active.has(manifest.id))
            throw Error('Already active');
        (0, service_contracts_cjs_1.checkRequirements)(manifest, this.services);
        const cleanups = [], granted = new Set(this.profile.grants?.[manifest.id] || []);
        const context = Object.freeze({
            apiVersion: package_validation_cjs_1.HOST_API_VERSION,
            profileId: this.profile.id,
            config: structuredClone(this.profile.config?.plugins?.[manifest.id] || {}),
            requireCapability: capability => {
                if (!manifest.capabilities.includes(capability) || !granted.has(capability))
                    throw Error(`Capability not granted: ${capability}`);
            },
            provide: (name, implementation) => {
                if (!manifest.capabilities.includes(`service:${name}`) || !granted.has(`service:${name}`))
                    throw Error(`Service not granted: ${name}`);
                if (this.services.has(name))
                    throw Error(`Service conflict: ${name}`);
                this.services.set(name, (0, service_contracts_cjs_1.validateService)(name, implementation));
                cleanups.push(() => this.services.delete(name));
            },
            consume: name => { if (!this.services.has(name))
                throw Error(`Service unavailable: ${name}`); return this.services.get(name); },
            onDispose: callback => { if (typeof callback !== 'function')
                throw Error('Invalid cleanup'); cleanups.push(callback); },
        });
        try {
            const dispose = await module.activate(context);
            if (typeof dispose === 'function')
                cleanups.push(dispose);
            this.active.set(manifest.id, cleanups);
        }
        catch (error) {
            const errors = [error];
            for (const cleanup of cleanups.reverse())
                try {
                    await cleanup();
                }
                catch (cleanupError) {
                    errors.push(cleanupError);
                }
            if (errors.length > 1)
                throw new AggregateError(errors, 'Plugin activation and cleanup failed');
            throw error;
        }
    }
    async activateComposition(manifests, load, { entrypoint = 'browser' } = {}) {
        if (this.active.size)
            throw Error('Composition already active');
        const ordered = (0, profile_resolver_cjs_1.validateComposition)(this.profile, manifests);
        let current;
        try {
            for (const manifest of ordered) {
                current = manifest;
                if (!manifest.entrypoints?.[entrypoint])
                    continue;
                const capability = entrypoint === 'browser' ? 'browser:code' : 'native:code';
                if (!manifest.capabilities.includes(capability) || !this.profile.grants?.[manifest.id]?.includes(capability))
                    throw Error(`Execution not granted: ${manifest.id}`);
                await this.activate(manifest, await load(manifest));
            }
            return this;
        }
        catch (cause) {
            const errors = [cause];
            try {
                await this.dispose();
            }
            catch (error) {
                errors.push(error);
            }
            throw new AggregateError(errors, `Package startup failed: ${current?.id || 'composition'}: ${cause.message}`);
        }
    }
    async dispose() {
        const errors = [];
        for (const callbacks of [...this.active.values()].reverse())
            for (const callback of [...callbacks].reverse()) {
                try {
                    await callback();
                }
                catch (error) {
                    errors.push(error);
                }
            }
        this.active.clear();
        if (errors.length)
            throw new AggregateError(errors, 'Plugin disposal failed');
    }
}
exports.PluginHost = PluginHost;

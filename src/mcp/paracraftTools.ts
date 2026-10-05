import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { dispatchAction, listClients, listParacraftActions, paracraftLauncher } from '../core/paracraftClients';
import { readInstance, readToken } from '../core/config';
import { currentRequest } from './context';
import { recordCall } from './sessions';
import { readCreationGuide } from './paracraftGuide';
import { compileCreationTemplate, creationTemplateInfo, creationTemplateCategories, searchCreationTemplates } from './paracraftTemplates';
import { summarizeCreationJob } from './paracraftJobResult';

export interface ParacraftTransport { port: number; viaHub?: boolean }

const launchSchemas = {
    launch: z.object({ projectId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), waitSeconds: z.number().min(0).max(20).default(15) }).strict(),
    launch_status: z.object({ launchId: z.string().min(1), waitSeconds: z.number().min(0).max(20).default(0) }).strict(),
};
const templateInfoSchema = z.object({ template: z.string().min(1).optional(),
    category: z.enum(creationTemplateCategories).optional(), query: z.string().trim().min(1).max(120).optional(),
    offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(10).optional(),
}).strict().refine(args => !args.template || Object.keys(args).length === 1, 'Choose one template or a discovery query');
// A crashed or test hub may leave a discovery record behind. Do not send a
// mutation to that dead port or retry it; choose the configured hub before I/O.
function hubPort(runtime: ParacraftTransport): number {
    const instance = readInstance();
    if (!instance || !Number.isInteger(instance.pid) || instance.pid <= 0
        || !Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65535) return runtime.port;
    try { process.kill(instance.pid, 0); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return runtime.port;
        // Permission denial does not establish that the process is absent.
    }
    return instance.port;
}
async function launchRequest(runtime: ParacraftTransport, action: 'launch' | 'launch_status', params: Record<string, unknown>) {
    if (!runtime.viaHub) return { status: 200, body: action === 'launch'
        ? await paracraftLauncher.launch(params.projectId as number, params.waitSeconds as number)
        : await paracraftLauncher.status(params.launchId as string, params.waitSeconds as number) };
    const port = hubPort(runtime), token = readToken();
    const response = await fetch(`http://127.0.0.1:${port}/paracraft/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(params), signal: AbortSignal.timeout(25000),
    });
    return { status: response.status, body: await response.json() };
}

// Stdio is a client of the singleton hub, not a second Paracraft registry.
export async function paracraftRequest(runtime: ParacraftTransport, clientId?: string, action?: string, params: Record<string, unknown> = {}) {
    if (!runtime.viaHub) return clientId && action ? dispatchAction(clientId, action, params) : { status: 200, body: await listClients() };
    const port = hubPort(runtime);
    const token = readToken();
    const path = clientId && action ? `/paracraft/${encodeURIComponent(clientId)}/${action}` : '/paracraft/clients';
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: clientId ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: clientId ? JSON.stringify(params) : undefined,
        signal: AbortSignal.timeout(25000),
    });
    return { status: response.status, body: await response.json() as unknown };
}

export function paracraftResult(status: number, body: unknown, image = false): CallToolResult {
    const envelope = body as { ok?: boolean; error?: string; result?: Record<string, unknown> } | null;
    const payload = envelope?.result || envelope as Record<string, unknown> | null;
    if (status !== 200 || envelope?.ok === false || payload?.ok === false) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
    }
    if (image) {
        if (typeof payload?.base64 !== 'string' || !['image/jpeg', 'image/png'].includes(String(payload.mimeType)) || payload.cached === true) {
            return { isError: true, content: [{ type: 'text', text: 'Fresh image unavailable; no cached image substituted.' }] };
        }
        const { base64, ...metadata } = payload;
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: base64, mimeType: String(payload.mimeType) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const identity = z.object({ clientId: z.string(), worldPath: z.string(), sessionId: z.union([z.number(), z.string()]) }).strict();
const client = { clientId: z.string().min(1) };
const job = { ...client, expectedIdentity: identity, requestId: z.string().min(1).max(128), timeoutSeconds: z.number().min(1).max(600).optional() };
export const creationSchemas = {
    world_docs: z.object({ ...client, expectedIdentity: identity, operation: z.enum(['init', 'update']), files: z.array(z.object({path:z.string().min(1),content:z.string().max(524288),expectedContent:z.string().optional(),create:z.boolean().optional()}).strict()).min(1).max(32).optional() }).strict(),
    analyze_world: z.object({ ...client, expectedIdentity: identity, kind:z.enum(['code','movie','sign','module']).optional(), bounds:z.object({min:vector,max:vector}).strict().optional(), cursor:z.string().optional(), view:z.enum(['auto','summary','objects']).optional() }).strict(),
    get_scene_info: z.object({ ...client, anchor: z.enum(['player', 'pet', 'camera']).optional() }).strict(),
    query_scene: z.object({ ...client, chunkX: z.number().int().min(-4096).max(4095), chunkZ: z.number().int().min(-4096).max(4095), cursor: z.string().optional() }).strict(),
    read_scene_object: z.object({ ...client, details: z.boolean().optional(), detailOffset: z.number().int().min(0).max(1000000).optional(), ref: z.object({ worldSession: z.string(), kind: z.enum(['block', 'entity', 'world_object']), position: vector.optional(), id: z.string().optional() }) }).strict(),
    get_creation_capabilities: z.object(client).strict(),
    read_official_wiki: z.object({ ...client, path: z.string() }).strict(),
    find_build_site: z.object({ ...job, dimensions: vector, clearance: z.number().int().min(0).max(8).optional(), radius: z.number().int().min(1).max(128).optional(), exclude: z.array(vector).max(100).optional() }).strict(),
    run_code: z.object({ ...job, code: z.string().min(1).max(65536), scene: z.record(z.string(), z.unknown()).optional() }).strict(),
    run_template: z.object({ ...job, template: z.string().min(1).max(64), templateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), origin: z.tuple([z.number().int(), z.number().int(), z.number().int()]).optional(), palette: z.record(z.string(), z.string().regex(/^#[a-fA-F0-9]{6}$/)).optional(), assets: z.record(z.string(), z.string().min(1).max(512)).optional(), saveSource: z.boolean().default(false) }).strict(),
    code_job: z.union([
        z.object({ ...client, expectedIdentity: identity, jobId: z.string().min(1).max(128), operation: z.enum(['status', 'cancel']).default('status'), resultDetail: z.enum(['summary', 'full']).default('summary') }).strict(),
        z.object({ ...client, expectedIdentity: identity, requestId: z.string().min(1).max(128), operation: z.enum(['status', 'cancel']).default('status'), resultDetail: z.enum(['summary', 'full']).default('summary') }).strict(),
    ]),
    screenshot: z.object({ ...client, expectedIdentity: identity }).strict(),
    camera_capture: z.object({ ...client, expectedIdentity: identity, moviePosition: vector.optional(), timeSeconds: z.number().min(0).max(600).optional(), eye: vector.optional(), lookat: vector.optional(), nearPet: z.boolean().optional(), nearPlayer: z.boolean().optional(), view: z.enum(['orbit', 'overhead', 'forward', 'front']).optional(), offset: vector.optional(), targetOffset: vector.optional(), assembly: z.object({moviePosition:vector,timeSeconds:z.number().min(0).max(600),actors:z.array(z.string().min(1).max(64)).min(1).max(16).optional(),yaw:z.number().min(-Math.PI*2).max(Math.PI*2).optional(),elevation:z.number().min(-1.4).max(1.4).optional(),distanceMeters:z.number().min(0.01).max(1000).optional(),size:z.union([z.literal(128),z.literal(256),z.literal(512),z.literal(1024)]).optional()}).strict().optional(), asset: z.object({filename:z.string().min(1).max(512),animId:z.number().int().min(0).max(65535).optional(),timeSeconds:z.number().min(0).max(600).optional(),yaw:z.number().min(-Math.PI*2).max(Math.PI*2).optional(),elevation:z.number().min(-1.4).max(1.4).optional(),distanceMeters:z.number().min(0.01).max(1000).optional(),size:z.union([z.literal(128),z.literal(256),z.literal(512),z.literal(1024)]).optional()}).strict().optional() }).strict(),
};
const descriptions: Record<keyof typeof creationSchemas, string> = {
    world_docs: 'Initialize or update world AGENTS.md and flat docs/*.md managed sections. Updates use expectedContent from world_files reads. Preserves user text; does not save the native world.',
    analyze_world: 'Index saved and live code blocks, movies, signs and smart modules without loading regions or executing code. Default auto summarizes inventories above 50 objects; summary forces grouping, objects returns pages of 50. Follow the summary cursor with view objects and the same filters to expand. Inspect world_object refs for details. Terrain remains unverified.',
    get_scene_info: 'Read world, player, pet and camera positions without loading terrain.',
    query_scene: 'Read paginated exposed surfaces in one loaded chunk column; not proof of full-volume clearance.',
    read_scene_object: 'Read a session-scoped scene reference. Set details for miniature voxels, models, bones and paginated movie keyframes.',
    get_creation_capabilities: 'Discover creation library version, limits, exporter and current world identity before executing source. Read creation.md for APIs.',
    read_official_wiki: 'Read the engine-owned official wiki, including creation.md, before authoring CodeBlock source.',
    find_build_site: 'Have the virtual pet inspect and navigate to a suitable empty site within 128 blocks in loaded terrain. Returns a job ID; poll code_job. Does not move the player or build blocks.',
    run_code: 'Run normal CodeBlock Lua with createScene(), including automatic pet site selection when origin is omitted. Normal CodeBlock authority, not a restricted sandbox. Returns a job ID; poll code_job. Request IDs deduplicate execution. Never retry with a new ID after timeout.',
    run_template: 'Run a packaged creation template without copying Lua; template_info describes its asset writes and palette. Automatic pet scouting unless origin is supplied. Native run_code jobs, world identity, chat ordering and deduplication apply. Save source only with saveSource=true; never saves the world.',
    code_job: 'Read creation/scouting status or cancel owned execution. Supply exactly one jobId or original requestId; request lookup recovers a lost first response without recompiling or repeating mutations and requires requestJobLookup. Results summarize dense rotation-key arrays by default; resultDetail="full" reads unchanged details. Completion is distinct from visual verification. Cancellation does not undo arbitrary CodeBlock commands.',
    screenshot: 'Capture a fresh native viewport including editor UI and return an MCP image. Cached fallback is rejected.',
    camera_capture: 'Capture an independent fresh scene image using world eye/lookat or nearPet/nearPlayer presets; asset renders one world-local .x/.bmax, and assembly renders MovieBlock actors together on a neutral canvas. Does not move the player or main camera.',
};

export function registerCreationTools(server: McpServer, runtime: ParacraftTransport) {
    const connectionSession = randomUUID();
    server.registerTool('paracraft_cli', {
        description: 'Paracraft CLI. Start with action="help" or "skill". Discover action schemas and load focused skill references on demand. Execute, inspect and capture through this single tool.',
        inputSchema: z.object({ action: z.string().min(1), clientId: z.string().min(1).optional(),
            chatSessionId: z.string().min(1).max(128).regex(/^[\w.-]+$/).optional(),
            petId: z.string().min(1).max(64).regex(/^[\w-]+$/).optional(),
            params: z.record(z.string(), z.unknown()).optional() }).strict(),
    }, async ({ action, clientId, chatSessionId, petId, params: input }) => {
        const started = Date.now(), ctx = currentRequest();
        const authoringSession = chatSessionId || ctx.sessionId || connectionSession;
        let ok = false;
        try {
            const params = { ...(input || {}) };
            let result: CallToolResult;
            if (action === 'context') {
                result = { content: [{ type: 'text', text: JSON.stringify({ chatSessionId: authoringSession, petId: petId || 'main',
                    note: 'Retain chatSessionId across reconnects. Chats sharing an MCP connection must supply different IDs. Creation jobs are serial within a chat; petId selects a named reference within that chat.' }) }] };
            } else if (action === 'skill') {
                const args = z.object({ path: z.string().default('SKILL.md') }).strict().parse(params);
                result = { content: [{ type: 'text', text: JSON.stringify(readCreationGuide(args.path)) }] };
            } else if (action === 'template_info') {
                const args = templateInfoSchema.parse(params);
                result = { content: [{ type: 'text', text: JSON.stringify(args.template ? creationTemplateInfo(args.template) : searchCreationTemplates(args)) }] };
            } else if (action === 'help') {
                const args = z.object({ action: z.string().optional() }).strict().parse(params);
                const schema = creationSchemas[args.action as keyof typeof creationSchemas] || launchSchemas[args.action as keyof typeof launchSchemas] || (args.action === 'template_info' ? templateInfoSchema : undefined);
                const actions = ['help', 'skill', 'context', 'clients', 'launch', 'launch_status', 'template_info', 'run_template', ...listParacraftActions()];
                if (args.action && !actions.includes(args.action)) throw new Error('unsupported_action');
                const details = args.action ? {
                    action: args.action,
                    description: descriptions[args.action as keyof typeof descriptions] || (args.action === 'template_info' ? 'Read one named template with source hash, or discover up to ten metadata-only candidates by category/query with pagination. Source is loaded only for a selected name.' : args.action === 'launch' ? 'Omit projectId to start/reuse an idle desktop for local worlds; supply projectId to enter that project. No clientId or login token required. Poll launch_status if waiting; never repeat a launch after a transport timeout.' : args.action === 'launch_status' ? 'Poll a launch. target=client becomes ready on desktop registration; target=project requires matching world entry. ready returns clientId.' : undefined),
                    inputSchema: schema ? z.toJSONSchema(schema, { io: 'input' }) : undefined,
                    usage: args.action === 'skill' ? { action: 'skill', params: { path: 'SKILL.md' } }
                        : args.action === 'clients' ? { action: 'clients' }
                        : args.action === 'launch' ? { action: 'launch', params: { projectId: 530 } }
                        : args.action === 'launch_status' ? { action: 'launch_status', params: { launchId: '<returned launchId>' } }
                        : { action: args.action, clientId: '<selected client>', params: {} },
                    note: schema ? 'Put clientId, chatSessionId and petId at the top level; other action arguments go in params.' : 'CLI parameters pass through to the engine. Use context to retain chat identity; read the relevant wiki before mutations.',
                } : { actions, next: 'Use help with params.action for one action schema; skill for the creation workflow; clients to discover worlds.' };
                result = { content: [{ type: 'text', text: JSON.stringify(details) }] };
            } else if (action === 'launch' || action === 'launch_status') {
                const paramsChecked = launchSchemas[action].parse(params);
                const response = await launchRequest(runtime, action, paramsChecked);
                result = paracraftResult(response.status, response.body);
            } else if (action === 'clients') {
                z.object({}).strict().parse(params);
                const response = await paracraftRequest(runtime);
                result = paracraftResult(response.status, response.body);
            } else {
                if (action !== 'run_template' && !listParacraftActions().includes(action)) throw new Error('unsupported_action: use help');
                if (!clientId) throw new Error('clientId required: use clients');
                const schema = creationSchemas[action as keyof typeof creationSchemas];
                let templateInput: z.infer<typeof creationSchemas.run_template> | undefined;
                if (schema) {
                    const validated = schema.parse({ ...params, clientId });
                    if (action === 'run_template') templateInput = validated as z.infer<typeof creationSchemas.run_template>;
                    const { clientId: ignored, ...validatedParams } = validated;
                    Object.assign(params, validatedParams);
                }
                if (['run_code', 'run_template', 'find_build_site', 'code_job', 'get_scene_info', 'camera_capture', 'screenshot'].includes(action)) {
                    params.authoringSession = authoringSession;
                    params.petId = petId || 'main';
                }
                if (action === 'screenshot') params.fresh = true;
                if (action === 'code_job' && params.requestId) {
                    const capabilities = await paracraftRequest(runtime, clientId, 'get_creation_capabilities');
                    if (!(capabilities.body as {result?: {requestJobLookup?: boolean}})?.result?.requestJobLookup) {
                        throw new Error('unsupported_capability: request-based job recovery; update the Paracraft engine or use the returned jobId');
                    }
                }
                if (action === 'camera_capture' && (params.asset || params.assembly)) {
                    const capabilities = await paracraftRequest(runtime, clientId, 'get_creation_capabilities');
                    const captureCapabilities=(capabilities.body as {result?: {isolatedAssetCapture?: boolean;isolatedAssemblyCapture?: boolean}})?.result;
                    if (params.assembly ? !captureCapabilities?.isolatedAssemblyCapture : !captureCapabilities?.isolatedAssetCapture) {
                        throw new Error(`unsupported_capability: isolated ${params.assembly ? 'assembly' : 'asset'} capture; update the Paracraft engine`);
                    }
                }
                const sameIdentity = (a: unknown, b: unknown) => {
                    const x = a as Record<string, unknown> | undefined, y = b as Record<string, unknown> | undefined;
                    return !!x && !!y && x.clientId === y.clientId && x.worldPath === y.worldPath && x.sessionId === y.sessionId;
                };
                if (action === 'world_docs' || action === 'analyze_world') {
                    const response = await paracraftRequest(runtime, clientId, 'get_creation_capabilities');
                    const capabilities = (response.body as {result?: Record<string, unknown>})?.result;
                    const capability = action === 'world_docs' ? 'worldDocuments' : 'worldAnalysis';
                    if (!capabilities?.[capability]) throw new Error(`unsupported_capability: ${capability}; update the Paracraft engine`);
                    if (!sameIdentity(capabilities.identity, params.expectedIdentity)) throw new Error('world_session_changed; discover and read world instructions again');
                }
                if (action === 'screenshot') {
                    const before = await paracraftRequest(runtime, clientId, 'get_creation_capabilities');
                    const identityNow = (before.body as { result?: { identity?: unknown } })?.result?.identity;
                    if (!sameIdentity(identityNow, params.expectedIdentity)) throw new Error('world_session_changed or unsupported engine');
                }
                const resultDetail = action === 'code_job' ? params.resultDetail : 'full';
                if (action === 'code_job') delete params.resultDetail; // Local presentation option; older engines see no new argument.
                let nativeAction = action, nativeParams = params;
                let templateMetadata;
                if (action === 'run_template') {
                    const { template, templateHash, origin, palette, saveSource, ...forwarded } = params;
                    const prepared = compileCreationTemplate(templateInput!, authoringSession);
                    if (prepared.requiredCapabilities.length) {
                        const capabilities = await paracraftRequest(runtime, clientId, 'get_creation_capabilities');
                        const available = (capabilities.body as { result?: Record<string, unknown> })?.result;
                        for (const name of prepared.requiredCapabilities) {
                            if (capabilities.status !== 200 || available?.[name] !== true) {
                                throw new Error(`unsupported_capability: ${name} required by ${template}; update the Paracraft engine`);
                            }
                        }
                        if (!sameIdentity(available?.identity, forwarded.expectedIdentity)) throw new Error('world_session_changed');
                    }
                    nativeAction = 'run_code'; nativeParams = { ...forwarded, code: prepared.code };
                    templateMetadata = prepared.metadata;
                }
                const response = await paracraftRequest(runtime, clientId, nativeAction, nativeParams);
                if (templateMetadata && response.status === 200) {
                    const payload = (response.body as { result?: Record<string, unknown> })?.result;
                    if (payload) payload.template = templateMetadata;
                }
                if (action === 'screenshot') {
                    const after = await paracraftRequest(runtime, clientId, 'get_creation_capabilities');
                    const identityNow = (after.body as { result?: { identity?: unknown } })?.result?.identity;
                    if (!sameIdentity(identityNow, params.expectedIdentity)) throw new Error('world_session_changed');
                    const payload = (response.body as { result?: Record<string, unknown> })?.result;
                    if (payload) payload.identity = identityNow;
                }
                const responseBody = action === 'code_job' && resultDetail === 'summary' && response.status === 200
                    ? summarizeCreationJob(response.body) : response.body;
                result = paracraftResult(response.status, responseBody, action === 'screenshot' || action === 'camera_capture');
            }
            ok = !result.isError;
            return result;
        } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: String(error) }] };
        } finally {
            if (ctx.sessionId) recordCall({ sessionId: ctx.sessionId, origin: ctx.origin, tool: 'paracraft_cli', summary: `${action} client=${clientId || ''}`, ok, durationMs: Date.now() - started });
        }
    });
}

import { randomUUID } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import {readCreationGuide} from '../mcp/paracraftGuide';
// Geometry, palettes and CodeBlock programs are authored in the current turn.
const vector = { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer' } };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const name = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' };
const file = { type: 'string', pattern: '^blocktemplates/[A-Za-z0-9_-]+\\.bmax$' };

function boxes(voxel: boolean) {
    const properties: Record<string, unknown> = { at: vector, size: vector, color };
    if (!voxel) properties.blockId = { type: 'integer', minimum: 1 };
    return {
        type: 'array', minItems: 1, maxItems: 128,
        items: {
            type: 'object', required: ['at', 'size', voxel ? 'color' : 'blockId'],
            properties, additionalProperties: false,
        },
    };
}

function tool(name: string, description: string, required: string[], properties: Record<string, unknown>) {
    const parameters = {
        type: 'object', required: ['worldPath', ...required],
        properties: { worldPath: { type: 'string' }, ...properties }, additionalProperties: false,
    };
    return { type: 'function', function: { name, description, parameters } };
}

export const creationTools = [
    {type:'function',function:{name:'open_blank_world',description:'Create and enter a fresh named local superflat world on the selected client. Returns the confirmed worldPath.',parameters:{type:'object',required:['name'],properties:{name:{type:'string',minLength:1,maxLength:100}},additionalProperties:false}}},
    tool('frame_scene',
        'Compose the main camera around an absolute BLOCK-coordinate center without teleporting the player. Distance in blocks, yaw/pitch in degrees. Use this followed by take_screenshot to see an entire creation or a close-up. For an overview choose distance about twice the footprint width.',
        ['center','distance'],{center:vector,distance:{type:'number',minimum:2,maximum:100},pitch:{type:'number',minimum:5,maximum:85},yaw:{type:'number',minimum:-360,maximum:360}}),
    tool('restart_actor_program',
        'After reading and correcting an actor with update_code_block, restart its physical CodeBlock at the returned position. Checks actor name and exact current source before execution.',
        ['position','name','expectedCode'],{position:vector,name,expectedCode:{type:'string',maxLength:65536}}),
    tool('place_block_shapes',
        'Place your own layout of solid cuboids into empty loaded world cells. origin is absolute; each at is an offset from it; size is cell counts along X,Y,Z. Later boxes override earlier boxes within this call. Limit 4096 generated cells. ColorBlock 10 supports #RRGGBB.',
        ['origin','boxes'],{origin:vector,boxes:boxes(false)}),
    tool('make_voxel_model',
        'Design a new world-local BMax from your own colored cuboids in integer voxel coordinates. Choose the actor scale separately. Later boxes override earlier ones in the same model. Limit 4096 generated cells. Returns actual filename and occupied voxel count.',
        ['filename','boxes'],{filename:file,boxes:boxes(true)}),
    tool('create_scripted_actor',
        'Create and start a named movie actor controlled by your supplied editable CodeBlock program. Absolute block coordinates: station is the movie block; its code block is one cell along +Z. position is the actor starting point. Use human or the returned world BMax filename as model.',
        ['name','model','position','station','code'],{name,model:{type:'string'},scale:{type:'number',minimum:0.01,maximum:8},position:vector,station:vector,code:{type:'string',minLength:1,maxLength:16000}}),
    tool('sample_actor',
        'Read a live actor in block units with model, scale, load state and CodeBlock diagnostics. For following or coordinated movement set relativeTo to the other actor name for positions from the same engine tick. For a repeating behavior provide seconds (1–15) to trace positions throughout a cycle with one call.',
        ['name'], { name, relativeTo: name, seconds: { type: 'integer', minimum: 1, maximum: 15 } }),
];


const validator = new AjvJsonSchemaValidator();

export const authoringPage = 'references/aichat-web.md';
export function getAuthoringCatalog() {
    return { version: 1, skill: readCreationGuide(authoringPage), tools: creationTools };
}
type Request = (action:string, params:Record<string,unknown>) => Promise<any>;

// dest is the native transport pinned by the hub to one registered client.
export async function executeAuthoring(name:string, args:Record<string,unknown>, dest:Request) {
    const action = creationTools.find(tool => tool.function.name === name);
    if (!action) throw new Error('Unknown Paracraft authoring action');
    const validation = validator.getValidator(action.function.parameters)(args);
    if (!validation.valid) throw new Error('Invalid authoring arguments: ' + validation.errorMessage);
    if (name === 'open_blank_world') {
        const prior = await dest('run_command',{world:{operation:'status'}});
        const added = await dest('run_command',{world:{operation:'create',name:args.name}});
        if (added.status !== 'created') throw new Error('Name already exists; inspect before choosing a fresh name');
        await dest('run_command',{world:{operation:'open',name:args.name,expectedWorldPath:prior.worldPath || '',confirmSwitch:true}});
        const end = Date.now()+45000;
        do {
            const status = await dest('run_command',{world:{operation:'status'}});
            if (status.worldEntered && status.worldPath === added.worldPath) return status;
            await new Promise(resolve=>setTimeout(resolve,400));
        } while(Date.now()<end);
        throw new Error('World entry pending; inspect status before retrying');
    }
    const {identity} = await dest('world_files',{operation:'identity'});
    if (!identity || identity.worldPath !== args.worldPath || !Number.isInteger(identity.sessionId)) throw new Error('Selected world changed; inspect status');
    const json = JSON.stringify({operation:name,args,worldPath:identity.worldPath,sessionId:identity.sessionId});
    let delim='=';
    while(json.includes(']'+delim+']')) delim+='=';
    const code='local request=commonlib.Json.Decode(['+delim+'['+json+']'+delim+'])\n'+readCreationGuide('scripts/web-authoring.lua').content;
    const execute=async()=>(await dest('run_npl_code',{code})).result;
    if (name!=='sample_actor' || args.seconds===undefined) return execute();
    const seconds=Number(args.seconds);
    if(!Number.isInteger(seconds)||seconds<1||seconds>15) throw new Error('Trace duration must be 1 to 15 seconds');
    const start=Date.now(),trace=[];
    let sample;
    do {
        if(trace.length) await new Promise(resolve=>setTimeout(resolve,500));
        sample=await execute();
        trace.push({
            ms: Date.now() - start, position: sample.position, found: sample.found,
            ...(args.relativeTo ? { referencePosition: sample.referencePosition ?? null } : {}),
        });
    } while(Date.now()-start<seconds*1000);
    return {...sample,trace};
}

// Web clients can relay MCP's native requests over their existing postMessage
// connection. Each single-use ticket resumes exactly one pending engine call.
type BridgePacket = { done: true; result: unknown } | { done: false; ticket: string; action: string; params: Record<string, unknown> };
type EngineReply = { ok?: boolean; error?: string; result?: any };
type Resume = (reply: EngineReply) => Promise<BridgePacket>;
const browserSteps = new Map<string, { clientId: string; resume: Resume }>();

export function advanceWebAuthoring(input: Record<string, unknown>): Promise<BridgePacket> {
    const clientId = input.clientId;
    if (typeof clientId !== 'string' || !clientId) throw new Error('Missing selected client');
    if (typeof input.ticket === 'string') {
        const step = browserSteps.get(input.ticket);
        if (!step || step.clientId !== clientId) throw new Error('Expired or mismatched engine reply');
        browserSteps.delete(input.ticket);
        return step.resume((input.reply || {}) as EngineReply);
    }
    if (browserSteps.size >= 128) throw new Error('Too many pending engine calls');
    let send: (packet: BridgePacket) => void;
    let fail: (reason: unknown) => void;
    const next = () => new Promise<BridgePacket>((resolve, reject) => { send = resolve; fail = reject; });
    const first = next();
    const native: Request = (action, params) => new Promise((resolve, reject) => {
        const ticket = randomUUID();
        const timer = setTimeout(() => {
            browserSteps.delete(ticket);
            reject(new Error('Engine reply timed out'));
        }, 30000);
        timer.unref();
        browserSteps.set(ticket, { clientId, resume(reply) {
            clearTimeout(timer);
            const packet = next();
            if (reply.ok === true) resolve(reply.result);
            else reject(new Error(String(reply.error || 'Engine request failed')));
            return packet;
        } });
        send({ done: false, ticket, action, params });
    });
    executeAuthoring(String(input.name), (input.args || {}) as Record<string, unknown>, native)
        .then(result => send({ done: true, result }), error => fail(error));
    return first;
}

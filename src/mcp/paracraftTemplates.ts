import { createHash } from 'node:crypto';
import { readCreationGuide } from './paracraftGuide';

// Curated runnable templates, not a recursive directory catalog in every call.
const templates = {
    patio_lantern: { path: 'examples/patio-lantern.lua', description: '0.25 m wide, 0.5 m tall decorative candle lantern: thin open frame, stepped cap and loop handle; color-only scale-1 asset, no light emission.', dimensions: [6, 3, 6], assetCount: 1, requiredCapabilities: ['voxelBoxBatch'],
        palette: { metal: '#3C4B4C', edge: '#63716D', wax: '#E6D7AE', flame: '#E8AF56' } },
    terracotta_planter: { path: 'examples/terracotta-planter.lua', description: '0.5 m wide, 0.875 m tall leafy planter with tapered hollow terracotta walls, thick rim, soil and exposed stem; reusable color-only scale-1 asset.', dimensions: [6, 3, 6], assetCount: 1, requiredCapabilities: ['voxelBoxBatch'],
        palette: { clay: '#B76E4D', lip: '#D38D65', soil: '#554338', stem: '#69754A', leaf: '#52784C', light: '#77945C' } },
    bistro_table: { path: 'examples/bistro-table.lua', description: '0.75 m round slatted wood café table at 0.75 m height, dark edge and central pedestal/cross foot; batched color-only scale-1 asset.', dimensions: [6, 3, 6], assetCount: 1, requiredCapabilities: ['voxelBoxBatch'],
        palette: { timber: '#B58C65', light: '#C49D72', rim: '#866247', metal: '#454D50' } },
    garden_chair: { path: 'examples/garden-chair.lua', description: '0.5 m slatted patio chair with 0.4375 m seat, open back and slightly splayed metal legs; batched color-only geometry at scale 1. Requires voxelBoxBatch.', dimensions: [6, 3, 6], assetCount: 1, requiredCapabilities: ['voxelBoxBatch'],
        palette: { timber: '#698F86', highlight: '#85A49A', metal: '#454D50' } },
    garden_parasol: { path: 'examples/garden-parasol.lua', description: '2.25 m eight-panel cream/teal canvas parasol, 2.375 m overall height, compact weighted stand; batched color-only source and a scale-1 instance.', dimensions: [9, 4, 7], assetCount: 1,
        palette: { cream: '#E6DBBE', teal: '#6B938A', rim: '#54766F', metal: '#565C57', finial: '#A07B50' } },
    picnic_table: { path: 'examples/picnic-table.lua', description: '1.75 m slatted picnic table, 0.8125 m tabletop and 0.4375 m seats, tapered A-frame supports; editable color-only source and one scale-1 instance.', dimensions: [8, 3, 6], assetCount: 1,
        palette: { timber: '#B18457', edge: '#88603F', support: '#51483E' } },
    garden_pergola: { path: 'examples/garden-pergola.lua', description: '~4.25 m garden pergola, 2.5 m visible/2 m collision headroom, native fence feet/flush timber and upper-slab paving, fine beams and climbing roses.', dimensions: [8, 4, 8], assetCount: 0,
        palette: { timber: '#FFFFFF', leaf: '#5E824C', stem: '#3F6240', rose: '#C67998', highlight: '#F1C6D2', paving: '#ADA391' } },
    pond_garden: { path: 'examples/pond-garden.lua', description: '12 × 11 m flush waterside garden with a contained irregular pond, native reeds/lily pads/flowers and a reusable 1.5 m slatted bench.', dimensions: [12, 3, 11], assetCount: 1,
        palette: { timber: '#A47851', metal: '#455759' } },
    curious_fox: { path: 'examples/skinned-fox.lua', headLook: true, description: '~0.78 m seven-bone fox with independently bound head looking ±25° in idle, embedded stepping ID and 1/32 baked normalization.', dimensions: [30, 16, 30], assetCount: 2,
        palette: { fur: '#C86F38', cream: '#EADBC0', dark: '#343039', innerEar: '#A55B55' } },
    skinned_fox: { path: 'examples/skinned-fox.lua', description: '~0.78 m six-bone young fox with embedded idle/trot-in-place IDs, explicit carrier binding and 1/32 baked technical-rig normalization.', dimensions: [30, 16, 30], assetCount: 2,
        palette: { fur: '#C86F38', cream: '#EADBC0', dark: '#343039', innerEar: '#A55B55' } },
    idle_fox: { path: 'examples/idle-fox.lua', description: '~0.75 m stylized young fox with pointed ears, cream muzzle/chest, planted dark paws and a root-bone swaying cream-tipped tail.', dimensions: [7, 3, 7], assetCount: 2,
        palette: { fur: '#C86F38', cream: '#EADBC0', dark: '#343039', innerEar: '#A55B55' } },
    banking_aircraft: { path: 'examples/light-aircraft.lua', flight: true, description: 'Scale-1 light aircraft with a looped airborne bank/yaw demonstration and all five rigid parts following the body frame.', dimensions: [24, 8, 14], assetCount: 3,
        palette: { body: '#E9E0C8', accent: '#B4583E', glass: '#668E9F', metal: '#47545B', blade: '#6B503C', bladeTip: '#D5B56D', tire: '#303738', rim: '#A6B0B1' } },
    light_aircraft: { path: 'examples/light-aircraft.lua', description: '6.2 m single-seat light aircraft, 8 m high wing, reusable landing wheels and a Z-axis spinning propeller; parked preview.', dimensions: [24, 4, 14], assetCount: 3,
        palette: { body: '#E9E0C8', accent: '#B4583E', glass: '#668E9F', metal: '#47545B', blade: '#6B503C', bladeTip: '#D5B56D', tire: '#303738', rim: '#A6B0B1' } },
    rowing_boat: { path: 'examples/rowing-boat.lua', description: '3.5 m open rowboat with two seats, reusable animated oars and a contained native water/dock preview.', dimensions: [14, 3, 12], assetCount: 2,
        palette: { hull: '#A7774B', keel: '#6D4A36', rim: '#D0A06A', seat: '#C5AA7D', sole: '#835C43', stripe: '#547D85', oar: '#B98B58', blade: '#E0BD83' } },
    compact_car: { path: 'examples/compact-car.lua', description: '3.75 m hatchback with open wheel arches, tapered ends, four reusable rotating tires, straight travel and parked front-wheel steering.', dimensions: [10, 3, 10], assetCount: 2,
        palette: { body: '#C96448', roof: '#EDE2C9', glass: '#557B88', glassHighlight: '#A6C4CC', headlights: '#FFF0B1', taillights: '#993B3D', trim: '#47515A', tire: '#2D3038', rim: '#C7CDD1', marker: '#E9BF73' } },
    desk_fan: { path: 'examples/desk-fan.lua', description: '~0.78 m desktop fan with a curved rotating rotor.', dimensions: [6, 3, 6], assetCount: 2,
        palette: { base: '#40575C', frame: '#71918D', guard: '#ABC1B4', blade: '#B57843', bladeTip: '#DFA86C', hub: '#DDE3CC', switch: '#DCAC73' } },
    butterfly: { path: 'examples/flapping-butterfly.lua', description: '~12.5 cm butterfly with separately flapping wings.', dimensions: [6, 3, 6], assetCount: 3,
        palette: { outline: '#40332B', eye: '#E9CB85', innerWing: '#F4C75A', wing: '#E59334', spots: '#EEE0BC' } },
    bird: { path: 'examples/flapping-bird.lua', description: '~31 cm garden bird with wings, tail and restrained hover.', dimensions: [7, 3, 7], assetCount: 4,
        palette: { body: '#66797A', head: '#695747', breast: '#CEB38A', beak: '#D8AC6D', eye: '#292C2A', foot: '#9F794F', feather: '#718783', featherTip: '#405354', innerWing: '#AAB4A6' } },
    conifer_garden: { path: 'examples/conifer-garden.lua', description: '7 m conifer, native spruce leaves/understory and a flush path.', dimensions: [9, 8, 8], assetCount: 0,
        palette: { bark: '#5D4839', barkLight: '#786048' } },
    cherry_garden: { path: 'examples/cherry-garden.lua', description: '6 m branching cherry, native blossoms, fallen petals and a flush path.', dimensions: [9, 7, 8], assetCount: 0,
        palette: { bark: '#725347', barkLight: '#93715D', petal: '#EBC3D1' } },
    mini_character: { path: 'examples/mini-character.lua', description: '1.75 m color-voxel person with a native two-bone rig and embedded idle/wave IDs.', dimensions: [12, 5, 8], assetCount: 2,
        palette: { shoes: '#373F50', trousers: '#3B526F', shirt: '#559E94', skin: '#E9C8A6', hair: '#514236', eyes: '#303340', mouth: '#B97F70' } },
} as const;

function load(name: string) {
    if (!Object.prototype.hasOwnProperty.call(templates, name)) throw new Error('unknown_template: load the relevant skill guide');
    const entry = templates[name as keyof typeof templates];
    let source = readCreationGuide(entry.path).content;
    if ('flight' in entry && entry.flight) {
        const marker = 'local flight=false';
        if (source.split(marker).length !== 2) throw new Error('template_variant_changed');
        source = source.replace(marker, 'local flight=true');
    }
    if ('headLook' in entry && entry.headLook) {
        const marker = 'local headLook=false';
        if (source.split(marker).length !== 2) throw new Error('template_variant_changed');
        source = source.replace(marker, 'local headLook=true');
    }
    const hash = createHash('sha256').update(source).digest('hex');
    return { entry, source, hash };
}

export function creationTemplateInfo(name: string) {
    const { entry, source, hash } = load(name);
    return { template: name, ...entry, templateHash: hash, sourceBytes: Buffer.byteLength(source),
        writesAssets: entry.assetCount > 0, savesWorld: false, savesSourceByDefault: false,
        note: 'Runs normal CodeBlock source; assetCount states explicit world-local exports. Inspect fresh views and poses; job completion is not visual approval.' };
}

export interface TemplateInput {
    template: string;
    templateHash?: string;
    requestId: string;
    expectedIdentity: { clientId: string; worldPath: string; sessionId: string | number };
    origin?: [number, number, number];
    saveSource?: boolean;
    palette?: Record<string, string>;
}
export function compileCreationTemplate(input: TemplateInput, authoringSession: string) {
    const { entry, source, hash } = load(input.template);
    if (input.templateHash && input.templateHash !== hash) throw new Error('template_changed: inspect template_info before a new request; recover pending work through code_job');
    // Stable across transport retries/reconnects. Distinct chats/worlds/requests
    // get distinct filenames; a new timestamp must not change deduplication input.
    const key = JSON.stringify([input.expectedIdentity.clientId, input.expectedIdentity.worldPath, input.expectedIdentity.sessionId, authoringSession, input.requestId, input.template]);
    const sceneName = 'tpl_' + createHash('sha256').update(key).digest('hex').slice(0, 24);
    const marker = /createScene\(\{name="[\w-]+"/g;
    if ([...source.matchAll(marker)].length !== 1) throw new Error('template_format_changed');
    const origin = input.origin ? `,origin={${input.origin.join(',')}}` : '';
    let code = source.replace(marker, `createScene({name="${sceneName}"${origin}`);
    const overrides = new Map<string, string>();
    for (const [role, color] of Object.entries(input.palette || {})) {
        if (!Object.prototype.hasOwnProperty.call(entry.palette, role)) throw new Error('unknown_palette_role: read template_info');
        if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new Error('invalid_color: use #RRGGBB');
        const original = (entry.palette as Record<string, string>)[role];
        if (!source.includes(original)) throw new Error('template_palette_changed');
        overrides.set(original, color.toUpperCase());
    }
    // One simultaneous pass: swapping two palette colors must not cascade.
    code = code.replace(/#[A-Fa-f0-9]{6}/g, color => overrides.get(color.toUpperCase()) || color);
    if (input.saveSource) {
        const saveMarker = 'local info=s:inspect();';
        if (code.split(saveMarker).length !== 2) throw new Error('template_save_marker_changed');
        code = code.replace(saveMarker, 's:save();' + saveMarker);
    }
    if (Buffer.byteLength(code) > 65536) throw new Error('template_source_too_large');
    return { code, requiredCapabilities: 'requiredCapabilities' in entry ? [...entry.requiredCapabilities] : [], metadata: { template: input.template, templateHash: hash, sceneName, palette: input.palette || {}, sourceSavedWhenCompleted: !!input.saveSource, worldSaved: false } };
}

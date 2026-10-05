import { createHash } from 'node:crypto';
import { readCreationGuide } from './paracraftGuide';

// Curated runnable templates, not a recursive directory catalog in every call.
const templates = {
    timber_cottage: { path: 'examples/timber-cottage.lua', description: '5 x 5 m unfurnished native timber/wool cottage: 3 m walls, five tinted panes, open 2 m door, colored stair roof with 5.5 m slab ridge, flush floor/path and thin carpet. No exports.', dimensions: [7, 6, 8], assetCount: 0,
        requiredCapabilities: ['doorAssemblies', 'terrainEditing', 'nativeBlockNames', 'sceneCameraPoints'], palette: { wall: '#E5DDC8', roof: '#8C5B48', glass: '#91B9B9', rug: '#BE997C' } },
    doorway: { path: 'examples/doorway.lua', description: 'Two native 1 x 2 m wooden doors, one closed and one open, in timber frames over a flush wood floor. Two-cell helper preflight and one undo command per door; no exports.', dimensions: [6, 3, 4], assetCount: 0,
        requiredCapabilities: ['doorAssemblies', 'terrainEditing', 'nativeBlockNames', 'sceneCameraPoints'], palette: { glass: '#AAC9C9' } },
    pocket_pond: { path: 'examples/pocket-pond.lua', description: '4 x 4 m garden with a flush 2 x 2 m native-water pond, solid masonry bed, horizontal lily pad, three bank plants and 1 m gravel path. Twelve backed-up ground cells; no exports.', dimensions: [4, 2, 4], assetCount: 0,
        requiredCapabilities: ['nativeBlockNames', 'sceneCameraPoints', 'terrainEditing'], palette: {} },
    trotting_dog: { path: 'examples/trotting-dog.lua', description: 'Small floppy-eared dog, about 0.55 m nose-to-rump and 0.44 m tall. Three color-only meshes, four independent rigid legs and tail; editable idle/trot in place, no knee IK or embedded clips.', dimensions: [9, 3, 7], assetCount: 3,
        requiredCapabilities: ['voxelBoxBatch', 'keyframeBatches', 'sceneCameraPoints'], palette: { fur: '#B89166', cream: '#E8D6B6', ear: '#6F513B', nose: '#302E2B', collar: '#5D9F9B' } },
    reading_corner: { path: 'examples/reading-corner.lua', description: '4 x 4 m open cutaway room, 3 m walls with native glass pane, flush wood floor and thin patterned native carpet. Reuses a 1.5 m bench and 0.875 m planter at scale 1; no exports.', dimensions: [4, 3, 4], assetCount: 0,
        requiredCapabilities: ['nativeBlockNames', 'sceneCameraPoints', 'modelOffset', 'modelContactPlacement', 'modelDependencies', 'creationModelReferences'],
        assetSlots: { bench: 'blocktemplates/bench.x', plant: 'blocktemplates/plant.x' }, palette: { wall: '#E5DDCA', glass: '#9EC1C4', rug: '#C39B7B', stripe: '#7EA79B' } },
    flower_border: { path: 'examples/flower-border.lua', description: '4 x 4 m native rose/dandelion border with sparse grass, visible bare soil and a flush 1 m gravel path. Four native plants, nine backed-up ground cells; no exports.', dimensions: [4, 2, 4], assetCount: 0,
        requiredCapabilities: ['nativeBlockNames', 'sceneCameraPoints'], palette: {} },
    birdbath_garden: { path: 'examples/birdbath-garden.lua', description: '7 x 7 m seating garden: reused 1.5 m bench and 0.75 m decorative birdbath, native oak-leaf hedges/flowers, flush paving and open front. Two scale-1 instances, no exports or native fluid.', dimensions: [7, 3, 7], assetCount: 0,
        requiredCapabilities: ['nativeBlockNames', 'modelOffset', 'modelContactPlacement', 'modelDependencies'],
        assetSlots: { bench: 'blocktemplates/bench.x', bath: 'blocktemplates/bath.x' }, palette: { rail: '#F2EBDD' } },
    sitting_cat: { path: 'examples/sitting-cat.lua', description: 'Small seated tabby, about 0.59 m including curved tail and 0.45 m to pointed ears; pale paws/muzzle, pink ears, green eyes and side stripes. Two color-only scale-1 meshes and rigid tail idle, no gait.', dimensions: [7, 3, 7], assetCount: 2, requiredCapabilities: ['voxelBoxBatch', 'keyframeBatches'],
        palette: { fur: '#C2A67D', cream: '#E2D6B9', pink: '#C6938D', stripe: '#7D6957', iris: '#95B0A8', eyes: '#35413B' } },
    hopping_rabbit: { path: 'examples/hopping-rabbit.lua', description: '0.453 m long stylized rabbit with four planted paws, muzzle/tail and two independently tilting ears. Editable idle and toy-like rigid hop; three color-only scale-1 meshes, no embedded clips.', dimensions: [7, 3, 7], assetCount: 3, requiredCapabilities: ['voxelBoxBatch', 'keyframeBatches'],
        palette: { fur: '#B19B81', cream: '#DDD2BB', pink: '#C69091', eyes: '#32353A' } },
    garden_birdbath: { path: 'examples/garden-birdbath.lua', description: '0.75 m round birdbath, 0.6875 m high, stepped pedestal and hollow raised rim; recessed blue decorative basin, color-only scale-1 asset, no native liquid.', dimensions: [6, 3, 6], assetCount: 1, requiredCapabilities: ['voxelBoxBatch'],
        palette: { stone: '#AAA89B', edge: '#CBC9B9', water: '#6C9FA8' } },
    bench_garden: { path: 'examples/bench-garden.lua', description: '5 × 6 m pocket garden: 1.5 m reused bench, two planters, flush native paving, pale rail and sparse native roses/yellow flowers/grass. No exports.', dimensions: [5, 3, 6], assetCount: 0,
        requiredCapabilities: ['nativeBlockNames', 'modelOffset', 'modelContactPlacement', 'modelDependencies'],
        assetSlots: { bench: 'blocktemplates/bench.x', plant: 'blocktemplates/plant.x' }, palette: { rail: '#F2EBDD' } },
    garden_bench: { path: 'examples/garden-bench.lua', description: '1.5 m two-seat garden bench, open wood slats, dark narrow frames and lower brace; 0.4375 m seat, 0.9375 m top, color-only scale-1 asset.', dimensions: [7, 3, 6], assetCount: 1, requiredCapabilities: ['voxelBoxBatch'],
        palette: { timber: '#A7815E', light: '#BD9872', metal: '#454D50' } },
    patio_cafe: { path: 'examples/patio-cafe.lua', description: '10 × 8 m terrace with two 0.75 m tables, four human-scale chairs, two tabletop lanterns, three planters, flush native wood/stone floor, white native fence and roses; 11 reused scale-1 instances, no exports.', dimensions: [10, 3, 8], assetCount: 0,
        requiredCapabilities: ['modelOffset', 'modelContactPlacement', 'modelDependencies'],
        assetSlots: { table: 'blocktemplates/table.x', chair: 'blocktemplates/chair.x', plant: 'blocktemplates/plant.x', lantern: 'blocktemplates/lantern.x' }, palette: { rail: '#FFFFFF' } },
    tabletop_lantern: { path: 'examples/model-contact.lua', description: 'Reuse a verified 0.75 m bottom-pivot round table and 0.5 m lantern at scale 1; flush native floor and exact tabletop contact. No exports; two required world-local assets.', dimensions: [6, 3, 6], assetCount: 0,
        requiredCapabilities: ['modelOffset', 'modelContactPlacement', 'modelDependencies'],
        assetSlots: { table: 'blocktemplates/table.x', lantern: 'blocktemplates/lantern.x' }, palette: {} },
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
    mini_character: { path: 'examples/mini-character.lua', description: '1.75 m color-voxel person with a native two-bone rig and embedded idle/wave IDs.', dimensions: [12, 5, 8], assetCount: 2, requiredCapabilities: ['keyframeBatches'],
        palette: { shoes: '#373F50', trousers: '#3B526F', shirt: '#559E94', skin: '#E9C8A6', hair: '#514236', eyes: '#303340', mouth: '#B97F70' } },
} as const;

export const creationTemplateCategories = ['architecture', 'gardens', 'furniture', 'animals', 'characters', 'moving_objects'] as const;
const categories: Record<typeof creationTemplateCategories[number], readonly (keyof typeof templates)[]> = {
    architecture: ['timber_cottage', 'doorway', 'reading_corner', 'garden_pergola'],
    gardens: ['pocket_pond', 'flower_border', 'birdbath_garden', 'bench_garden', 'patio_cafe', 'pond_garden', 'conifer_garden', 'cherry_garden'],
    furniture: ['garden_birdbath', 'garden_bench', 'tabletop_lantern', 'patio_lantern', 'terracotta_planter', 'bistro_table', 'garden_chair', 'garden_parasol', 'picnic_table'],
    animals: ['trotting_dog', 'sitting_cat', 'hopping_rabbit', 'curious_fox', 'skinned_fox', 'idle_fox', 'butterfly', 'bird'],
    characters: ['mini_character'],
    moving_objects: ['banking_aircraft', 'light_aircraft', 'rowing_boat', 'compact_car', 'desk_fan'],
};

// Discovery reads curated metadata only; source/hash loading stays name-specific.
export function searchCreationTemplates(options: { category?: string; query?: string; offset?: number; limit?: number } = {}) {
    const offset = options.offset ?? 0, limit = options.limit ?? 5;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('invalid_template_page');
    if (options.category && !Object.prototype.hasOwnProperty.call(categories, options.category)) throw new Error('unknown_template_category');
    if (options.query !== undefined && (typeof options.query !== 'string' || options.query.trim().length === 0 || options.query.length > 120)) throw new Error('invalid_template_query');
    const terms = options.query?.trim().toLowerCase().split(/\s+/) || [];
    const names = (options.category ? [...categories[options.category as keyof typeof categories]] : Object.keys(templates))
        .sort().filter(name => {
            const entry = templates[name as keyof typeof templates];
            const text = (name.replace(/_/g, ' ') + ' ' + entry.description).toLowerCase();
            return terms.every(term => text.includes(term));
        });
    const page = names.slice(offset, offset + limit).map(name => {
        const entry = templates[name as keyof typeof templates];
        return { template: name, description: entry.description, dimensions: entry.dimensions,
            writesAssets: entry.assetCount > 0, assetCount: entry.assetCount,
            assetRoles: 'assetSlots' in entry ? Object.keys(entry.assetSlots) : [],
            requiredCapabilities: 'requiredCapabilities' in entry ? entry.requiredCapabilities : [] };
    });
    return { templates: page, categories: creationTemplateCategories, total: names.length, offset,
        nextOffset: offset + page.length < names.length ? offset + page.length : null };
}

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
    assets?: Record<string, string>;
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
    const slots: Record<string, string> = 'assetSlots' in entry ? entry.assetSlots : {};
    const assets = input.assets || {};
    for (const role of Object.keys(assets)) if (!Object.prototype.hasOwnProperty.call(slots, role)) throw new Error('unknown_asset_role: read template_info');
    const replacements = new Map<string, string>();
    for (const [role, placeholder] of Object.entries(slots)) {
        const file = assets[role];
        if (!file) throw new Error(`missing_asset_role: ${role}`);
        if (file.length > 512 || !/^blocktemplates\/[A-Za-z0-9_/-]+\.(?:x|bmax)$/.test(file) || file.includes('//')) throw new Error('invalid_asset_path: use a world-local blocktemplates model');
        if (!source.includes(`"${placeholder}"`)) throw new Error('template_asset_slot_changed');
        replacements.set(placeholder, file);
    }
    // Simultaneous substitution preserves role order when filenames are swapped.
    code = code.replace(/"(blocktemplates\/[A-Za-z0-9_/-]+\.(?:x|bmax))"/g, (quoted, file) => replacements.has(file) ? `"${replacements.get(file)}"` : quoted);
    if (input.saveSource) {
        const saveMarker = 'local info=s:inspect();';
        if (code.split(saveMarker).length !== 2) throw new Error('template_save_marker_changed');
        code = code.replace(saveMarker, 's:save();' + saveMarker);
    }
    if (Buffer.byteLength(code) > 65536) throw new Error('template_source_too_large');
    return { code, requiredCapabilities: 'requiredCapabilities' in entry ? [...entry.requiredCapabilities] : [], metadata: { template: input.template, templateHash: hash, sceneName, palette: input.palette || {}, assets, sourceSavedWhenCompleted: !!input.saveSource, worldSaved: false } };
}

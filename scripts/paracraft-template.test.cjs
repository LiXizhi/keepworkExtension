const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}
}).outputText,file);
const {compileCreationTemplate,creationTemplateInfo,searchCreationTemplates}=require('../src/mcp/paracraftTemplates.ts');
const {registerCreationTools}=require('../src/mcp/paracraftTools.ts');
const hub=require('../src/core/paracraftClients.ts');
const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {InMemoryTransport}=require('@modelcontextprotocol/sdk/inMemory.js');
const identity={clientId:'template-test',worldPath:'test/',sessionId:3};

test('CodeBlock template isolates shared state, names and assets and can persist editable source',()=>{
 const input={template:'codeblock_playground',expectedIdentity:identity,requestId:'game-a',saveSource:true};
 const a=compileCreationTemplate(input,'chat-a'),b=compileCreationTemplate({...input,requestId:'game-b'},'chat-a');
 assert.notEqual(a.metadata.sceneName,b.metadata.sceneName);
 assert.match(a.code,new RegExp('name="'+a.metadata.sceneName+'"'));
 assert.match(a.code,/local name=s.name;/);
 assert.match(a.code,/local key = name\.\.":round"/);
 assert.match(a.code,/local model="blocktemplates\/"\.\.name/);
 assert.match(a.code,/s:save\(\);local info=s:inspect\(\);/);
 assert.deepEqual(compileCreationTemplate(input,'chat-a'),a);
 assert.equal(searchCreationTemplates({category:'interactions'}).templates[0].template,input.template);
 assert.equal(creationTemplateInfo(input.template).assetCount,1);
});

test('template discovery pages metadata without reading source or scanning files',()=>{
 const read=fs.readFileSync,list=fs.readdirSync;
 fs.readFileSync=()=>{throw new Error('Discovery read source');};fs.readdirSync=()=>{throw new Error('Discovery scanned files');};
 try{
  const first=searchCreationTemplates();assert.equal(first.templates.length,5);assert.equal(first.nextOffset,5);
  const names=[];let offset=0;
  do{const page=searchCreationTemplates({offset,limit:10});names.push(...page.templates.map(t=>t.template));offset=page.nextOffset;}while(offset!==null);
  assert.equal(names.length,first.total);assert.equal(new Set(names).size,names.length);assert.deepEqual(names,[...names].sort());
  const classified=[];
  for(const category of first.categories){const page=searchCreationTemplates({category,limit:10});assert.equal(page.nextOffset,null);classified.push(...page.templates.map(t=>t.template));}
  assert.deepEqual(classified.sort(),names,'Missing or duplicated category membership');
  const cat=searchCreationTemplates({category:'animals',query:'CAT'});assert.deepEqual(cat.templates.map(t=>t.template),['sitting_cat']);
  const reused=searchCreationTemplates({query:'bench scale'});assert(reused.templates.every(t=>/bench/i.test(t.description)&&/scale/i.test(t.description)));
  assert.equal(searchCreationTemplates({query:'no_such_subject'}).total,0);assert.equal(searchCreationTemplates({offset:999}).nextOffset,null);
  for(const t of first.templates){assert.equal(t.content,undefined);assert.equal(t.templateHash,undefined);assert.equal(t.path,undefined);}
  for(const options of [{category:'__proto__'},{category:'constructor'},{limit:11},{limit:.5},{offset:-1},{query:' '},{query:'x'.repeat(121)}])assert.throws(()=>searchCreationTemplates(options));
 }finally{fs.readFileSync=read;fs.readdirSync=list;}
});

test('template requests compile deterministically and isolate scenes across requests/chats/worlds',()=>{
 const input={template:'bird',expectedIdentity:identity,requestId:'bird-1'};
 const one=compileCreationTemplate(input,'chat-a');
 assert.deepEqual(compileCreationTemplate(input,'chat-a'),one);
 assert.notEqual(compileCreationTemplate({...input,requestId:'bird-2'},'chat-a').metadata.sceneName,one.metadata.sceneName);
 assert.notEqual(compileCreationTemplate(input,'chat-b').metadata.sceneName,one.metadata.sceneName);
 assert.notEqual(compileCreationTemplate({...input,expectedIdentity:{...identity,sessionId:4}},'chat-a').metadata.sceneName,one.metadata.sceneName);
 assert(!one.code.includes('s:save();'));assert(!one.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 assert.match(compileCreationTemplate({...input,origin:[-12,5,10],saveSource:true},'chat-a').code,/,origin=\{-12,5,10\}/);
 assert(compileCreationTemplate({...input,saveSource:true},'chat-a').code.includes('s:save();local info='));
 const info=creationTemplateInfo('bird');assert.equal(info.assetCount,4);assert.equal(info.content,undefined);
 const rabbit=creationTemplateInfo('hopping_rabbit');assert.equal(rabbit.assetCount,3);assert.deepEqual(rabbit.dimensions,[7,3,7]);
 const cat=creationTemplateInfo('sitting_cat');assert.equal(cat.assetCount,2);assert.deepEqual(cat.dimensions,[7,3,7]);assert.deepEqual(cat.requiredCapabilities,['voxelBoxBatch','keyframeBatches']);
 const person=creationTemplateInfo('mini_character');assert.deepEqual(person.requiredCapabilities,['keyframeBatches']);const personRun=compileCreationTemplate({...input,template:'mini_character',palette:{shirt:'#62898A'}},'chat-a');assert.match(personRun.code,/#62898A/);assert.match(personRun.code,/s:keyframes\("wave","character",frames\)/);
 const catInput={...input,template:'sitting_cat',palette:{fur:'#B18C69'},saveSource:true};const catRun=compileCreationTemplate(catInput,'chat-a');assert.deepEqual(compileCreationTemplate(catInput,'chat-a'),catRun);assert.match(catRun.code,/#B18C69/);assert(!catRun.code.includes('#C2A67D'));assert(catRun.metadata.sourceSavedWhenCompleted);assert(!catRun.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 const rabbitRun=compileCreationTemplate({...input,template:'hopping_rabbit',palette:{fur:'#A68C72'}},'chat-a');assert.match(rabbitRun.code,/expectedMeters=\{0.25,0.3125,0.453125\}/);assert.match(rabbitRun.code,/rigidHop=true/);assert.match(rabbitRun.code,/#A68C72/);
 assert.deepEqual(rabbit.requiredCapabilities,['voxelBoxBatch','keyframeBatches']);assert.match(rabbitRun.code,/s:keyframes\("rabbit",part.name,trackFrames\)/);assert(!rabbitRun.code.includes('s:keyframe('));
 const pond=creationTemplateInfo('pond_garden');assert.equal(pond.assetCount,1);assert.equal(pond.content,undefined);assert.deepEqual(pond.dimensions,[12,3,11]);
 const pocket=creationTemplateInfo('pocket_pond');assert.equal(pocket.assetCount,0);assert.deepEqual(pocket.dimensions,[4,2,4]);assert.deepEqual(pocket.requiredCapabilities,['nativeBlockNames','sceneCameraPoints','terrainEditing']);
 const door=creationTemplateInfo('doorway');assert.equal(door.assetCount,0);assert.deepEqual(door.requiredCapabilities,['doorAssemblies','terrainEditing','nativeBlockNames','sceneCameraPoints']);const doorRun=compileCreationTemplate({...input,template:'doorway'},'chat-a');assert.match(doorRun.code,/s:door\(\{position=\{1,0,1\},data=1\}\)/);assert(!doorRun.code.includes('pcall('));
 const pocketRun=compileCreationTemplate({...input,template:'pocket_pond'},'chat-a');assert.match(pocketRun.code,/terrainDepth=2/);assert.match(pocketRun.code,/blockId="Still_Water"/);assert.match(pocketRun.code,/blockId="LilyPad",data=2/);assert(!pocketRun.code.includes('exportVoxelX'));assert(!pocketRun.code.includes('s:save();'));assert(!pocketRun.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 const pergola=creationTemplateInfo('garden_pergola');assert.equal(pergola.assetCount,0);assert.deepEqual(pergola.dimensions,[8,4,8]);
 const picnic=creationTemplateInfo('picnic_table');assert.equal(picnic.assetCount,1);assert.deepEqual(picnic.dimensions,[8,3,6]);
 const parasol=creationTemplateInfo('garden_parasol');assert.equal(parasol.assetCount,1);assert.deepEqual(parasol.dimensions,[9,4,7]);
 const chair=creationTemplateInfo('garden_chair');assert.equal(chair.assetCount,1);assert.deepEqual(chair.dimensions,[6,3,6]);
 const bench=creationTemplateInfo('garden_bench');assert.equal(bench.assetCount,1);assert.deepEqual(bench.dimensions,[7,3,6]);
 const benchRun=compileCreationTemplate({...input,template:'garden_bench',palette:{timber:'#B58C65'}},'chat-a');assert.match(benchRun.code,/expectedMeters=\{1.5,0.9375,0.46875\}/);assert.match(benchRun.code,/seatMeters=0.4375/);
 const bath=creationTemplateInfo('garden_birdbath');assert.equal(bath.assetCount,1);assert.deepEqual(bath.dimensions,[6,3,6]);
 const bathRun=compileCreationTemplate({...input,template:'garden_birdbath',palette:{water:'#6DA8B1'}},'chat-a');assert.match(bathRun.code,/expectedMeters=\{0.75,0.6875,0.75\}/);assert.match(bathRun.code,/decorativeWater=true/);assert.match(bathRun.code,/#6DA8B1/);
 const cafe=creationTemplateInfo('bistro_table');assert.equal(cafe.assetCount,1);assert.deepEqual(cafe.requiredCapabilities,['voxelBoxBatch']);
 const plant=creationTemplateInfo('terracotta_planter');assert.equal(plant.assetCount,1);assert.deepEqual(plant.requiredCapabilities,['voxelBoxBatch']);
 const lantern=creationTemplateInfo('patio_lantern');assert.equal(lantern.assetCount,1);assert.deepEqual(lantern.requiredCapabilities,['voxelBoxBatch']);
 const lanternRun=compileCreationTemplate({...input,template:'patio_lantern',palette:{metal:'#425050'}},'chat-a');assert.match(lanternRun.code,/#425050/);assert.match(lanternRun.code,/expectedMeters=\{0.25,0.5,0.25\}/);assert.match(lanternRun.code,/emitsLight=false/);
 const plantInput={...input,template:'terracotta_planter',palette:{clay:'#AA735A'},saveSource:true};const plantRun=compileCreationTemplate(plantInput,'chat-a');assert.deepEqual(compileCreationTemplate(plantInput,'chat-a'),plantRun);assert.match(plantRun.code,/#AA735A/);assert.match(plantRun.code,/expectedMeters=\{0.5,0.875,0.5\}/);
 const cafeInput={...input,template:'bistro_table',palette:{timber:'#AD8563'},saveSource:true};const cafeRun=compileCreationTemplate(cafeInput,'chat-a');assert.deepEqual(compileCreationTemplate(cafeInput,'chat-a'),cafeRun);assert.match(cafeRun.code,/#AD8563/);assert.match(cafeRun.code,/expectedMeters=\{0.75,0.75,0.75\}/);
 const chairInput={...input,template:'garden_chair',palette:{timber:'#B58C65'},saveSource:true};const chairRun=compileCreationTemplate(chairInput,'chat-a');assert.deepEqual(compileCreationTemplate(chairInput,'chat-a'),chairRun);assert.match(chairRun.code,/#B58C65/);assert.match(chairRun.code,/expectedMeters=\{0.5,0.9375,0.5\}/);assert.match(chairRun.code,/seatMeters=0.4375/);
 const parasolInput={...input,template:'garden_parasol',palette:{teal:'#769491'},saveSource:true};const parasolRun=compileCreationTemplate(parasolInput,'chat-a');assert.deepEqual(compileCreationTemplate(parasolInput,'chat-a'),parasolRun);assert.match(parasolRun.code,/#769491/);assert.match(parasolRun.code,/expectedMeters=\{2.25,2.375,2.25\}/);assert.match(parasolRun.code,/s:voxelBoxes/);
 const picnicInput={...input,template:'picnic_table',palette:{timber:'#C8A472'},saveSource:true};const picnicRun=compileCreationTemplate(picnicInput,'chat-a');assert.deepEqual(compileCreationTemplate(picnicInput,'chat-a'),picnicRun);assert.match(picnicRun.code,/#C8A472/);assert.match(picnicRun.code,/expectedMeters=\{1.75,0.8125,1.53125\}/);assert.match(picnicRun.code,/scale=1/);
 const pergolaInput={...input,template:'garden_pergola',palette:{timber:'#FFFFFF'},saveSource:true};
 const pergolaRun=compileCreationTemplate(pergolaInput,'chat-a');assert.deepEqual(compileCreationTemplate(pergolaInput,'chat-a'),pergolaRun);
 assert.match(pergolaRun.code,/terrainDepth=1/);assert.match(pergolaRun.code,/blockId=267/);assert.match(pergolaRun.code,/blockId=281,color=paving,data=1/);
 assert.match(pergolaRun.code,/visibleHeadroomMeters=2.5/);assert.match(pergolaRun.code,/collisionHeadroomMeters=2/);assert(!pergolaRun.code.includes('exportVoxelX'));
 const pondInput={...input,template:'pond_garden',palette:{timber:'#7A6352'},saveSource:true};
 const pondRun=compileCreationTemplate(pondInput,'chat-a');assert.deepEqual(compileCreationTemplate(pondInput,'chat-a'),pondRun);
 assert.match(pondRun.code,/#7A6352/);assert.match(pondRun.code,/terrainDepth=2/);assert.match(pondRun.code,/s:surface/);
 assert(pondRun.code.includes('s:save();local info='));assert(!pondRun.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 const fox=creationTemplateInfo('idle_fox');assert.equal(fox.assetCount,2);assert.equal(fox.content,undefined);
 const foxInput={...input,template:'idle_fox',palette:{fur:'#A97959',cream:'#F5EDDE'},saveSource:true};
 const foxRun=compileCreationTemplate(foxInput,'chat-a');
 assert.deepEqual(compileCreationTemplate(foxInput,'chat-a'),foxRun);
 assert.match(foxRun.code,/#A97959/);assert.match(foxRun.code,/#F5EDDE/);
 assert(!foxRun.code.includes('#C86F38'));assert(!foxRun.code.includes('#EADBC0'));
 assert.equal(foxRun.metadata.sourceSavedWhenCompleted,true);
 assert(!foxRun.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 const skinned=creationTemplateInfo('skinned_fox');assert.equal(skinned.assetCount,2);assert.deepEqual(skinned.dimensions,[30,16,30]);
 const skinnedInput={...input,template:'skinned_fox',palette:{fur:'#B78A60'},saveSource:true};
 const skinnedRun=compileCreationTemplate(skinnedInput,'chat-a');assert.deepEqual(compileCreationTemplate(skinnedInput,'chat-a'),skinnedRun);
 assert.match(skinnedRun.code,/#B78A60/);assert(!skinnedRun.code.includes('#C86F38'));assert.equal(skinnedRun.metadata.sourceSavedWhenCompleted,true);
 assert.notEqual(skinnedRun.metadata.sceneName,foxRun.metadata.sceneName);
 const curiousInput={...skinnedInput,template:'curious_fox'},curiousRun=compileCreationTemplate(curiousInput,'chat-a');
 assert.deepEqual(compileCreationTemplate(curiousInput,'chat-a'),curiousRun);
 assert.match(curiousRun.code,/local headLook=true/);assert.match(skinnedRun.code,/local headLook=false/);
 assert.notEqual(curiousRun.metadata.templateHash,skinnedRun.metadata.templateHash);
 assert.equal(creationTemplateInfo('curious_fox').assetCount,2);assert.match(curiousRun.code,/#B78A60/);
 const car=creationTemplateInfo('compact_car');assert.equal(car.assetCount,2);assert.equal(car.content,undefined);
 const carRun=compileCreationTemplate({...input,template:'compact_car',palette:{body:'#587F91'},saveSource:true},'chat-a');
 assert.match(carRun.code,/#587F91/);assert(carRun.code.includes('s:save();local info='));
 const boat=creationTemplateInfo('rowing_boat');assert.equal(boat.assetCount,2);assert.equal(boat.content,undefined);
 const boatInput={...input,template:'rowing_boat',palette:{hull:'#7A9289'}};
 const boatRun=compileCreationTemplate(boatInput,'chat-a');
 assert.deepEqual(compileCreationTemplate(boatInput,'chat-a'),boatRun);
 assert.match(boatRun.code,/#7A9289/);assert.match(boatRun.code,/terrainDepth=2/);
 assert(!boatRun.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 assert(!boatRun.code.includes('s:save();'));
 const aircraft=creationTemplateInfo('light_aircraft');assert.equal(aircraft.assetCount,3);
 const planeInput={...input,template:'light_aircraft',palette:{accent:'#587F91'},saveSource:true};
 const planeRun=compileCreationTemplate(planeInput,'chat-a');
 assert.deepEqual(compileCreationTemplate(planeInput,'chat-a'),planeRun);
 assert.match(planeRun.code,/#587F91/);assert(planeRun.code.includes('s:save();local info='));
 assert(!planeRun.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
 const bankInput={...planeInput,template:'banking_aircraft'};
 const bankRun=compileCreationTemplate(bankInput,'chat-a');
 assert.deepEqual(compileCreationTemplate(bankInput,'chat-a'),bankRun);
 assert.match(bankRun.code,/local flight=true/);assert.match(planeRun.code,/local flight=false/);
 assert.notEqual(bankRun.metadata.templateHash,planeRun.metadata.templateHash);
 assert.deepEqual(creationTemplateInfo('banking_aircraft').dimensions,[24,8,14]);
 assert.match(bankRun.code,/s:keyframes\("propeller",part.name,frames\)/);
 assert.match(bankRun.code,/else for _,frame in ipairs\(frames\) do s:keyframe/);
 for(const name of ['conifer_garden','cherry_garden']){
  const garden=creationTemplateInfo(name);assert.equal(garden.writesAssets,false);assert.equal(garden.assetCount,0);
  const run=compileCreationTemplate({...input,template:name},'chat-a');assert(!run.code.includes('exportVoxelX'));
 }
 assert.throws(()=>compileCreationTemplate({...input,templateHash:'a'.repeat(64)},'chat-a'),/template_changed/);
 for(const name of ['../examples/bird.lua','__proto__','constructor','missing'])assert.throws(()=>creationTemplateInfo(name),/unknown_template/);
});

test('cottage keeps native materials, meter dimensions and automatic placement without implicit persistence',()=>{
 const info=creationTemplateInfo('timber_cottage');
 assert.deepEqual(info.dimensions,[7,6,8]);assert.equal(info.assetCount,0);assert.equal(info.writesAssets,false);
 assert.deepEqual(info.requiredCapabilities,['doorAssemblies','terrainEditing','nativeBlockNames','sceneCameraPoints']);
 const input={template:'timber_cottage',expectedIdentity:identity,requestId:'cottage',palette:{wall:'#D9D0B9',roof:'#6C827C'}};
 const run=compileCreationTemplate(input,'chat');assert.deepEqual(compileCreationTemplate(input,'chat'),run);
 assert.match(run.code,/#D9D0B9/);assert.match(run.code,/#6C827C/);
 for(const material of ['Oak_Wood_Planks','Oak_Wood','White_Wool','GlassPane','White_Carpet','ColorBlock_Stairs','ColorBlock_Slab'])assert(run.code.includes('"'+material+'"'));
 assert.match(run.code,/s:door\(\{position=\{3,0,2\},data=1,open=true\}\)/);
 assert.match(run.code,/houseWidth=5,houseDepth=5/);assert.match(run.code,/ridgeHeight=5\.5,doorHeight=2/);
 assert.match(run.code,/detail=\{eye=s:cameraPoint\(\{3,1\.8,0\}\)/);
 assert.match(run.code,/s:surface/);assert.match(run.code,/terrainDepth=1/);
 assert(!run.code.includes('exportVoxelX'));assert(!run.code.includes('s:save();'));assert(!run.code.includes('pcall('));
 assert(!run.code.match(/createScene\(\{[^\n]+/)[0].includes(',origin='));
});

test('reuse templates require closed world-local asset roles and simultaneous filename substitution',()=>{
 const info=creationTemplateInfo('tabletop_lantern');assert.equal(info.assetCount,0);assert.equal(info.writesAssets,false);assert.equal(info.content,undefined);assert.deepEqual(Object.keys(info.assetSlots),['table','lantern']);
 const bath=creationTemplateInfo('birdbath_garden');assert.deepEqual(bath.dimensions,[7,3,7]);assert.equal(bath.writesAssets,false);assert.deepEqual(Object.keys(bath.assetSlots),['bench','bath']);
 const bathRun=compileCreationTemplate({template:'birdbath_garden',expectedIdentity:identity,requestId:'bath',assets:{bench:'blocktemplates/b.x',bath:'blocktemplates/w.x'},palette:{rail:'#FFFFFF'}},'chat');assert.match(bathRun.code,/blocktemplates\/b.x/);assert.match(bathRun.code,/blocktemplates\/w.x/);assert(!bathRun.code.includes('exportVoxelX'));
 const cafe=creationTemplateInfo('patio_cafe');assert.equal(cafe.assetCount,0);assert.deepEqual(cafe.dimensions,[10,3,8]);assert.deepEqual(Object.keys(cafe.assetSlots),['table','chair','plant','lantern']);
 const cafeRun=compileCreationTemplate({template:'patio_cafe',expectedIdentity:identity,requestId:'cafe',assets:{table:'blocktemplates/t.x',chair:'blocktemplates/c.x',plant:'blocktemplates/p.x',lantern:'blocktemplates/l.x'},palette:{rail:'#FFFFFF'}},'chat');assert.match(cafeRun.code,/blockId=267,color=rail/);assert.match(cafeRun.code,/blockId=115/);assert(!cafeRun.code.includes('exportVoxelX'));
 const nook=creationTemplateInfo('bench_garden');assert.equal(nook.assetCount,0);assert.deepEqual(nook.dimensions,[5,3,6]);assert(nook.requiredCapabilities.includes('nativeBlockNames'));
 const nookRun=compileCreationTemplate({template:'bench_garden',expectedIdentity:identity,requestId:'nook',assets:{bench:'blocktemplates/b.x',plant:'blocktemplates/p.x'}},'chat');assert.match(nookRun.code,/blockId="StoneBrick"/);assert.match(nookRun.code,/blockId="Red_Rose"/);assert(!nookRun.code.includes('exportVoxelX'));
 const base={template:'tabletop_lantern',expectedIdentity:identity,requestId:'reuse'};
 assert.throws(()=>compileCreationTemplate(base,'chat'),/missing_asset_role: table/);
 assert.throws(()=>compileCreationTemplate({...base,assets:{table:'blocktemplates/t.x'}},'chat'),/missing_asset_role: lantern/);
 assert.throws(()=>compileCreationTemplate({...base,assets:{extra:'blocktemplates/t.x'}},'chat'),/unknown_asset_role/);
 for(const file of ['../outside.x','blocktemplates/../outside.x','C:/outside.x','blocktemplates/a.x"; error(1)','blocktemplates//a.x','https://example.com/a.x'])assert.throws(()=>compileCreationTemplate({...base,assets:{table:file,lantern:'blocktemplates/l.x'}},'chat'),/invalid_asset_path/);
 const assets={table:'blocktemplates/lantern.x',lantern:'blocktemplates/table.x'},one=compileCreationTemplate({...base,assets},'chat');
 assert.match(one.code,/local tableFile="blocktemplates\/lantern.x"/);assert.match(one.code,/local lanternFile="blocktemplates\/table.x"/);
 assert.equal(compileCreationTemplate({...base,assets:{lantern:assets.lantern,table:assets.table}},'chat').code,one.code);
 assert.deepEqual(one.requiredCapabilities,['modelOffset','modelContactPlacement','modelDependencies']);assert.match(one.code,/s:requireModels\(\{tableFile,lanternFile\}\)/);assert(!one.code.includes('exportVoxelX'));
 assert.throws(()=>compileCreationTemplate({...base,template:'bird',assets},'chat'),/unknown_asset_role/);
});

test('named RGB palette swaps are simultaneous and cannot inject code or unknown roles',()=>{
 const input={template:'bird',expectedIdentity:identity,requestId:'palette'};
 const a=compileCreationTemplate({...input,palette:{body:'#695747',head:'#66797a'}},'chat-a');
 const b=compileCreationTemplate({...input,palette:{head:'#66797A',body:'#695747'}},'chat-a');
 assert.equal(a.code,b.code,'Palette key order/case changed retry source');
 assert.match(a.code,/0\.21875\},size=1\/32,color="#695747"/);
 assert.match(a.code,/0\.125\},size=1\/32,color="#66797A",replace=true/);
 assert.throws(()=>compileCreationTemplate({...input,palette:{missing:'#ffffff'}},'chat-a'),/unknown_palette_role/);
 assert.throws(()=>compileCreationTemplate({...input,palette:{body:'"});runCommand("exit")'}},'chat-a'),/invalid_color/);
});

test('required template capabilities reject older or changed worlds before mutation',async()=>{
 const server=new McpServer({name:'required-cap-test',version:'1'});registerCreationTools(server,{port:8089});
 const client=new Client({name:'required-cap-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);await hub.registerClient({clientId:identity.clientId});
 const input={template:'garden_chair',expectedIdentity:identity,requestId:'required-cap'};
 assert.deepEqual(creationTemplateInfo('garden_chair').requiredCapabilities,['voxelBoxBatch']);
 assert.deepEqual(compileCreationTemplate({...input,template:'picnic_table'},'cap-chat').requiredCapabilities,[]);
 const call=()=>client.callTool({name:'paracraft_cli',arguments:{action:'run_template',clientId:identity.clientId,chatSessionId:'cap-chat',params:input}});
 try{
  for(const caps of [{identity},{identity:{...identity,sessionId:99},voxelBoxBatch:true},{identity,voxelBoxBatch:true}]){
   const pending=call();const[read]=await hub.pollJobs(identity.clientId,2000);assert.equal(read.request.action,'get_creation_capabilities');hub.completeJob(identity.clientId,read.jobId,{ok:true,result:{ok:true,...caps}});
   if(caps.voxelBoxBatch&&caps.identity.sessionId===identity.sessionId){const[mutation]=await hub.pollJobs(identity.clientId,2000);assert.equal(mutation.request.action,'run_code');hub.completeJob(identity.clientId,mutation.jobId,{ok:true,result:{ok:true,jobId:'required-one'}});assert(!(await pending).isError);}
   else{const result=await pending;assert(result.isError);assert.match(result.content[0].text,caps.voxelBoxBatch?/world_session_changed/:/unsupported_capability: voxelBoxBatch/);assert.equal((await hub.pollJobs(identity.clientId,0)).length,0);}
  }
  const pending=client.callTool({name:'paracraft_cli',arguments:{action:'run_template',clientId:identity.clientId,chatSessionId:'cap-chat',params:{...input,template:'hopping_rabbit',requestId:'batch-cap'}}});
  const[read]=await hub.pollJobs(identity.clientId,2000);assert.equal(read.request.action,'get_creation_capabilities');hub.completeJob(identity.clientId,read.jobId,{ok:true,result:{ok:true,identity,voxelBoxBatch:true}});
  const rejected=await pending;assert(rejected.isError);assert.match(rejected.content[0].text,/unsupported_capability: keyframeBatches/);assert.equal((await hub.pollJobs(identity.clientId,0)).length,0);
 }finally{hub.unregisterClient(identity.clientId);await client.close();await server.close();}
});

test('single MCP tool translates template to native run_code without losing ownership or job recovery',async()=>{
 const server=new McpServer({name:'template-test',version:'1'});registerCreationTools(server,{port:8089});
 const client=new Client({name:'template-test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);await hub.registerClient({clientId:identity.clientId});
 const call=(action,params)=>client.callTool({name:'paracraft_cli',arguments:{action,clientId:identity.clientId,chatSessionId:'template-chat',petId:'detail',params}});
 try{
  assert.equal((await client.listTools()).tools.length,1);
  const animals=JSON.parse((await call('template_info',{category:'animals',limit:2})).content[0].text);
  assert.equal(animals.templates.length,2);assert.equal(animals.nextOffset,2);
  for(const params of [{template:'bird',category:'animals'},{limit:11},{offset:-1},{category:'missing'}])assert.equal((await call('template_info',params)).isError,true);
  assert.equal((await hub.pollJobs(identity.clientId,0)).length,0,'Discovery forwarded native work');
  const info=JSON.parse((await call('template_info',{template:'butterfly'})).content[0].text);
  for(let i=0;i<2;i++){
   const pending=call('run_template',{template:'butterfly',templateHash:info.templateHash,expectedIdentity:identity,requestId:'recover-same',saveSource:true});
   const[job]=await hub.pollJobs(identity.clientId,2000);assert.equal(job.request.action,'run_code');
   assert.equal(job.request.params.authoringSession,'template-chat');assert.equal(job.request.params.petId,'detail');
   assert.equal(job.request.params.requestId,'recover-same');assert.deepEqual(job.request.params.expectedIdentity,identity);
   assert.equal(job.request.params.code,compileCreationTemplate({template:'butterfly',expectedIdentity:identity,requestId:'recover-same',templateHash:info.templateHash,saveSource:true},'template-chat').code);
   assert.equal(job.request.params.template,undefined);
   hub.completeJob(identity.clientId,job.jobId,{ok:true,result:{ok:true,jobId:'native-same'}});
   const result=JSON.parse((await pending).content[0].text);assert.equal(result.result.jobId,'native-same');
   assert.equal(result.result.template.templateHash,info.templateHash);
  }
  for(const params of [
   {template:'bird',expectedIdentity:identity,requestId:'bad',origin:[0.5,1,1]},
   {template:'bird',expectedIdentity:identity,requestId:'bad',templateHash:'a'.repeat(64)},
   {template:'bird',requestId:'no-world'},
   {template:'../../package.json',expectedIdentity:identity,requestId:'bad'},
  ])assert.equal((await call('run_template',params)).isError,true);
  assert.equal((await hub.pollJobs(identity.clientId,0)).length,0,'Rejected template forwarded a mutation');
 }finally{hub.unregisterClient(identity.clientId);await client.close();await server.close();}
});

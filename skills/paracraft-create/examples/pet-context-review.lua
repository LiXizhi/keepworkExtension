-- Existing-scene review; replace name, retain this chat's context, save nothing.
-- Requires desktop scenePetReferences. Refuses to interrupt a busy pet.
local s=createScene({name="birdbath_garden",resume=true})
local origin=commonlib.deepcopy(s.origin)
local pet=s:petReference()
for i=1,3 do assert(origin[i]==s.origin[i],"reference moved construction origin")end
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,pet=pet}

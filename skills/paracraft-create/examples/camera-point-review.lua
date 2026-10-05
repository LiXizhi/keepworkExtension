-- Read-only review of an existing garden. Requires sceneCameraPoints capability.
-- Replace the name with a saved scene; no source, asset or world is saved.
local s=createScene({name="birdbath_garden",resume=true})
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
return{name=s.name,origin=s.origin,groups=groups,cameraPoints=true,
 overview={eye=s:cameraPoint({9,5.5,10}),lookat=s:cameraPoint({3,0.4,3})},
 detail={eye=s:cameraPoint({6.5,2.2,7}),lookat=s:cameraPoint({4,0.4,3.5})}}

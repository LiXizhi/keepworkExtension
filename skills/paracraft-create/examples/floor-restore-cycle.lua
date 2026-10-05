-- Read before use: replace the scene name with an existing saved garden.
-- Restore its owned floor, verify first-soil snapshots, then repaint the floor.
-- Leaves fixtures in place; saves the existing full generator and manifest.
local s=createScene({name="birdbath_garden",resume=true})
local origin=commonlib.deepcopy(s.origin)
local before,fixtures={},{}
for key,m in pairs(s.cells)do
 if m.group=="ground" then before[key]={position=m.position,original=commonlib.deepcopy(m.original)}
 else fixtures[key]=s.world:Fingerprint(s.world:Snapshot(m.position)) end
end
assert(#s.groups.ground==49,"this example expects the 7 x 7 m garden floor")
local removed=s:remove("ground")
assert(removed==49 and #s.groups.ground==0,"ground group not restored")
for _,m in pairs(before)do
 assert(s.world:Fingerprint(s.world:Snapshot(m.position))==s.world:Fingerprint(m.original),"original ground not restored")
end
s:group("ground")
s:surface({position={0,0,0},dimensions={7,1,7},blockId="Grass"})
s:surface({position={2,0,0},dimensions={2,1,7},blockId="Oak_Wood_Planks"})
s:surface({position={4,0,4},dimensions={2,1,1},blockId="Oak_Wood_Planks"})
for key,m in pairs(before)do
 assert(s.world:Fingerprint(s.cells[key].original)==s.world:Fingerprint(m.original),"rebuilt floor lost first-soil backup")
end
for key,fingerprint in pairs(fixtures)do
 assert(s.world:Fingerprint(s.world:Snapshot(s.cells[key].position))==fingerprint,"unrelated fixture changed")
end
for i=1,3 do assert(s.origin[i]==origin[i],"origin changed")end
-- This cycle ends at the existing wooden-floor design, so its full source stays valid.
s:save(s.savedSource);wait(1)
local info=s:inspect();local groups={}
for name,g in pairs(info.groups)do local stale=0;for _,m in ipairs(g.members)do if m.stale then stale=stale+1 end end;groups[name]={cells=#g.members,stale=stale,bounds=g.bounds}end
local base=s:toWorld({0,0,0});local one=s:toWorld({1,1,1})
local function view(p)local v={};for i=1,3 do v[i]=base[i]+p[i]*(one[i]-base[i])end;return v end
return{name=s.name,origin=s.origin,groups=groups,
 restoration={restoredCells=49,firstSoilRestored=true,backupsRetained=true,fixturesUnchanged=true,fixedOrigin=true},
 overview={eye=view({9,5.5,10}),lookat=view({3,0.4,3})},
 detail={eye=view({6.5,2.2,7}),lookat=view({4,0.4,3.5})}}

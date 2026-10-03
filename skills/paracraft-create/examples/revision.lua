-- Inspect before revising. This sample updates one owned floor cell and
-- returns camera coordinates. It does not overwrite the saved full generator.
local scene=createScene({name="pavilion",resume=true})
local before=scene:inspect()
scene:group("floor")
scene:surface({position={1,0,1},color="#cc9955"})
return {scene=scene:inspect(),eye=scene:toWorld({14,6,14}),lookat=scene:toWorld({4,2,4})}

-- Technical two-bone fixture: idle ID 0, wave ID 1.
-- Deliberately coarse construction for rig/export tests, not a realistic character.
-- Production assets must be normalized and independently checked at their intended
-- meter dimensions (human height about 1.75 m); preview scale alone is insufficient.
local scene=createScene({name="character",dimensions={16,12,16}})
scene:group("rig")
scene:bone({name="root",position={4,1,4},direction=4})
scene:box({position={3,1,4},dimensions={1,3,1},color="#44aaff"})
scene:bone({name="arm",position={4,4,4},direction=4,parent={4,1,4},pivot={0,-0.1,0}})
scene:box({position={5,4,4},dimensions={3,1,1},color="#ffaa44"})
scene:rig("rig")
scene:exportBmax("blocktemplates/character_rig.bmax","rig")
scene:group("movie")
scene:movie({name="clips",position={1,0,10},duration=3})
scene:actor("clips",{name="character",filename="blocktemplates/character_rig.bmax",position={10,0,10},scale=0.5,animId=0})
scene:keyframe("clips","character",0,{anim=0,bones={arm={rotation={0,0,0,1}}}})
scene:keyframe("clips","character",1,{anim=1,bones={arm={rotation={0,0,0,1}}}})
scene:keyframe("clips","character",1.5,{bones={arm={rotation={0,0,0.70710678,0.70710678}}}})
scene:keyframe("clips","character",2,{bones={arm={rotation={0,0,0.38268343,0.92387953}}}})
scene:keyframe("clips","character",2.5,{bones={arm={rotation={0,0,0.70710678,0.70710678}}}})
scene:keyframe("clips","character",3,{bones={arm={rotation={0,0,0,1}}}})
scene:seek("clips",1.5)
scene:exportX("blocktemplates/character_clips.x","clips")
scene:group("exported")
scene:model({position={10,0,4},filename="blocktemplates/character_clips.x",scale=0.5})
scene:save()
return {scene=scene:inspect(),rig=scene:rig("rig")}

-- Run in a disposable writable world through run_code. No coordinates needed.
-- Design scale: one block = one meter. 6 m deck, 8 m roof; workspace includes props.
local scene=createScene({name="pavilion",dimensions={16,8,16},terrainDepth=1})
scene:group("floor")
scene:surface({position={1,0,1},dimensions={6,1,6},blockId=81,data=0})
scene:group("columns")
for _,x in ipairs({2,5}) do
    for _,z in ipairs({2,5}) do
        scene:box({position={x,0,z},dimensions={1,3,1},blockId=98,data=0})
    end
end
scene:group("railings")
scene:line({from={2,0,1},to={5,0,1},blockId=267,color="#aa7744"})
scene:group("foliage")
scene:box({position={10,1,5},dimensions={1,2,3},blockId=86,data=0})
scene:group("roof")
scene:cone({position={0,3,0},dimensions={8,2,8},color="#338899",hollow=true})
scene:group("detail")
scene:box({position={10,0,2},dimensions={1,1,1},size=0.25,color="#ff6644"})
scene:sphere({position={10.75,1.25,2.75},dimensions={0.5,0.5,0.5},size=1/8,color="#ffbb44"})
scene:block({position={10.25,1.125,2.5},size=1/512,color="#ffffff"})
-- Export only this color-block prop; native scene materials stay in the world.
scene:group("prop")
scene:sphere({position={12,0,8},dimensions={1,1,1},size=0.25,color="#66bb33"})
scene:exportBmax("blocktemplates/pavilion_prop.bmax","prop")
scene:group("instance")
scene:model({position={12,0,12},filename="blocktemplates/pavilion_prop.bmax",scale=1})
scene:save()
return scene:inspect()

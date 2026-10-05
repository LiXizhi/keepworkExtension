# Native world materials: choose by appearance

These names/IDs come from Paracraft `config/Aries/creator/block_types.xml`.
They are not Minecraft numeric IDs. Check `block_types.names[name]` and
`block_types.get(id)` on the installed client: extensions can change the palette.
Use one relevant category below; do not load the entire registry into a prompt.
If capabilities include `nativeBlockNames:true`, prefer the exact palette name
in `blockId`, for example `blockId="Rose"`, over memorizing a numeric ID.
Names are case-sensitive native registry entries; older clients require verified IDs.
Native textures/models are preferred for ordinary world vegetation and fabrics.
Custom miniature color voxels remain useful for unusual species or art direction.
BMax/character visible geometry still uses color voxels only, not these materials.

| Scene need | Read only this palette |
|---|---|
| Meadow, forest, garden, waterside planting | [plants.md](materials/plants.md) |
| Soil, paths, beach, puddle or pool | [ground-water.md](materials/ground-water.md) |
| Rugs, runners, cushions and woven walls | [textiles.md](materials/textiles.md) |

Each palette explains appearance, exact registry name/ID and placement. A single
plant ID provides native textured geometry without many scripted color voxels.
The [native material garden](../examples/native-material-garden.lua) demonstrates
repeatable sparse plants, contained water and wool/carpet swatches. Do not load
all three palettes unless the current scene needs them.

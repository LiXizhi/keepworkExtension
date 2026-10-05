# Native wool and carpets

World-scene textiles; exportable BMax/character geometry remains color voxels only.

Wool is a full solid cube with a soft woven/fibrous texture. Carpets are thin
textured plates on a support surface: use them for rugs and runners, not walls.
Use `data=0` for the default horizontal carpet and inspect orientation when
using wall/other attachments. Carpet at y=0 sits on floor at y=-1; a floor
replacement belongs at y=-1. Fixed colored variants already provide the hue.

| Color / name prefix | Wool ID (`<prefix>_Wool`) | Carpet ID (`<prefix>_Carpet`) |
|---|---:|---:|
| White | 133 | 234 |
| Orange | 94 | 235 |
| Magenta | 25 | 236 |
| Light_Blue | 21 | 237 |
| Yellow | 27 | 238 |
| Lime | 93 | 239 |
| Pink | 96 | 240 |
| Gray | 134 | 241 |
| Light_Gray | 135 | 242 |
| Cyan | 20 | 243 |
| Purple | 24 | 244 |
| Blue | 19 | 245 |
| Brown | 136 | 246 |
| Green | 137 | 247 |
| Red | 23 | 248 |
| Black | 71 | 249 |

White_Wool 133, White_Carpet 234 and SoilCarpet 279 support uniform
`color="#RRGGBB"`; omit `color` for fixed textured variants that do not support
painting. Never pack color data manually. Wool can suit world-scene cushions,
fabric walls or banners, but do not export it as character/BMax body geometry.
Lazy `reading_corner` demonstrates a patterned White_Carpet rug using uniform
RGB roles over a flush wooden floor. Native carpet is already thin: do not raise
the floor by a block to support it or create a one-meter-thick wool rug.


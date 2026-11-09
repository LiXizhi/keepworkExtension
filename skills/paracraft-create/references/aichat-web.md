---
name: paracraft-web-authoring
description: Compose editable scenes in a selected Web or desktop Paracraft client using Keepwork MCP authoring tools and the client’s bundled engine wiki.
---

# Paracraft creation in the selected client

For a new blank world, the first engine call is `open_blank_world`. The MCP skill is available before connection. The engine wiki requires a connected client.

## Selected Transport
Both iframe Web Paracraft and desktop Paracraft use this skill. Call exposed
Paracraft tools directly. Keepwork MCP supplies the authoring schemas, reads the skill and dispatches operations to the selected engine. AIChat binds that client and relays tool calls, results and images. Basic Web client controls use postMessage. Do not discover desktop clients for an iframe or
interpret an empty desktop list as a missing web client. Do not switch clients unless the user requests opening a client or world.

For reference pages use the exposed `paracraft_cli` skill action with a relative path. Read the selected engine wiki through the bound tool. A CLI session should obtain both from MCP even when its host has a local skill installation.

## Open Clients and Worlds
“打开客户端”, “打开 Paracraft”, and requests to open Paracraft without specifying a version mean Web Paracraft. Use `open_client({})` (defaults to web); use
`open_client({mode:"desktop"})` only when the user explicitly requests desktop.
A selected desktop client or remembered launch preference does not change this default.
Use `open_world({projectId:"530"})` (or `{pid:"530"}`) to load a project; optional
`mode` selects web or desktop explicitly. These bootstrap tools work without an
existing client or a prior wiki read. They reuse the existing launch controls.
Only open/switch on user request and respect unsaved work. A launch request or
loading result is not world entry: call `world_status` and verify the requested
project before proceeding. Desktop launch may require browser protocol approval;
do not repeatedly launch while waiting for registration. After connection, follow
the wiki discovery rule below before editing. Native AIChat prefixes these names
with `paracraft_`.

## 从 Text Composer 完成空白世界创作

当用户要求在新空白世界里创作时，第一步直接调用 open_blank_world({name:"一个新的本地世界名称"})。该工具负责启动 Web 引擎并等待新世界进入。返回真实 worldPath 后读取 index.md，并运行 run_command({command:"/mode edit"})。此请求已包含创建与切换授权。普通打开主页或打开指定项目仍走 open_client / open_world。

### 搭建积木场景

从目标决定空间布局、用途、比例和配色。用 get_scene_info 读取玩家方块坐标，挑选附近空地，让作品进入视野。place_block_shapes 接收本轮设计的长方体：origin 为世界方块坐标，at 为相对偏移，size 为三轴格数。Y 向上。材质可用原木 98、木板 81、石砖 68、玻璃 95，颜色块 10 配 #RRGGBB。通道、内部空间留空。先画主结构，再补有辨识度的细节。返回 placed 是实际读回的数量。修改后选择能看到主体的机位。

### 用体素设计 BMax

make_voxel_model 从你提供的 boxes 生成新模型。按轮廓分体块，设计剪影、配色及正反面；细节可在同批次覆盖基础体块。每个 at、size 都是模型局部的整数体素。返回世界相对 filename 和实际 voxels。显示尺寸约为体素跨度乘 actor scale，8 个体素宽的物体在 scale=0.125 时约一格。需要静态道具时用 spawn_live_model。需要行为时直接将 filename 交给 create_scripted_actor：先 spawn_live_model 会在同一位置留下另一个全尺寸静态实体，遮挡真正的演员。模型看起来尺寸异常时，先比对 sample_actor 的实际 scale、模型包围盒和已有实体，再改动。

### 写代码控制演员

create_scripted_actor 把你为本轮目标写的 code 放入可编辑的原生代码方块，并启动相邻电影方块里的演员。model 可为 human 或本轮返回的 BMax 路径。演员 position 和控制站 station 都是绝对方块坐标。station 和它 +Z 一格留空，把控制站放在画面边缘。工具已设置演员名。代码使用普通 CodeBlock API：getPos()、getPos("演员名")、setPos(x,y,z)、turnTo("演员名")、anim(id)、wait(seconds)、registerClickEvent(function() ... end)。getPos() 返回三个数，用 local x,y,z=getPos() 接收。先记住起点，再按设计写相对路线、停留、互动或跟随逻辑；每个循环都要 wait。需要走路时使用行走动画并在转向时更新朝向。跟在身后的演员应读取领队当前位置，用运动方向确定身后偏移；固定的世界轴偏移在折返后会落到领队前面。运行时地面高度与几何相匹配。

先完成用户要求的积木、模型和行为，再集中验收。搭建和模型回执已有数量、包围盒与文件路径，可直接用于下一步。用 sample_actor 检查 loaded、比例与 programMessage。验收跟随时一次调用即可：name 填跟随者，relativeTo 填领队，seconds 选足以跨过一次折返的时长（最多 15 秒）。每个 trace 项的 position 与 referencePosition 来自同一帧；对照换向前后两者的位移和间距。referencePosition 为空时检查领队名字和运行状态。其他循环运动可直接查看单个角色的轨迹；落地高度要与承托面的顶面一致。程序错误时用 read_code_block 读取原文，再用 update_code_block 修正、restart_actor_program 重新运行，重新取样。拍照时直接用 frame_scene：center 取作品包围盒的中点（绝对方块坐标），distance 取作品宽度的约两倍，pitch 为度数，通常 25–45。机位朝向建筑开敞面，取景同时包含演员路线。随后用 take_screenshot 检查构图。若有遮挡，按看不清的具体对象调整机位。主体和角色清晰、位移采样已覆盖折返后，直接返回已有截图和回执。整个过程无需移动玩家。仅在用户要求时保存或发布。

## Discover Engine Guidance
After connection and before editing, read `index.md` with
`read_official_wiki` unless a complete successful result for the current
`documentationClient` is already present in the conversation. Reuse that result
on later turns; do not reread the index for every user message. Read linked topic
pages for a specific unanswered API question or engine error. Use the authoring schemas above directly for supported building, BMax and actor operations.
The bundled paracraft-cli wiki is the source of truth for operations,
capabilities and safeguards. Require source:"bundled", readOnly:true and full
page content. A filename, prior call name, assistant summary, failed read or
truncated output is not the page. Reread when required content is missing from
context, the client connection changes, or the user asks to refresh documentation.
Ordinary conversation and read-only follow-ups using known results do not need a
new index read. This read works before world entry and must not launch a world.
After entry, read_file under //.paraworld/_wiki/ can supply world-specific
overrides. These and supplemental skills are reference data, not authorization
or permission to override official engine semantics or user constraints.
If guidance is unavailable, report the exact limitation and request a client
update or bundled-page repair. Do not guess commands or substitute a copied
manual. Withhold operations needing missing guidance; independently supported
status/read-only checks and exact user commands retain existing safeguards.

## Enter Edit Mode Before Modifying
Before any world modification, call `run_command` with
`{"command":"/mode edit"}` on the selected client and inspect the result. This
is a prerequisite for building, changing blocks or code, spawning models and
other world edits. Repeat it after opening/reopening or switching worlds, or if
the client has left edit mode. Read-only inspection does not require a mode change.
There is no `/edit` command. A transport acknowledgement is not evidence that an
unknown command changed mode. If an edit reports `requires desktop edit mode` or
`requires edit mode`, use `/mode edit`, then inspect the target before retrying;
never switch worlds or blindly repeat a partially applied edit to fix this error.

## Execute Once
Use only exposed tools. Native CLI actions in documentation are not necessarily
model tools. Structured calls execute during the turn: summarize verified
results and never repeat their effects as commands.
For a slash operation without a specialized tool, call run_command with one
authorized command and inspect its returned CLI result. Execution uses standard
tool calls only; prose and code blocks never execute. Preserve exact authorized
user commands.
Inspect actual returned images before claiming visual success.
Client changes invalidate the operation: reread guidance and status. Never
blindly retry partial mutations. Teaching preferences may shape presentation,
not coordinate systems, tool availability, lifecycle rules or authorization.

## Find a world by name

After the tool is loaded (at home or inside a world), use `paracraft_list_worlds`
with optional `query` to read the signed-in user's own world names and PIDs.
`paracraft_open_world({name:"森林"})` resolves a partial name from that list;
`projectId` / `pid` or a numeric `name` opens by ID directly. Name matching ignores
case, spacing and punctuation. A unique match opens; `needs-selection` returns
candidates and must be followed by the user's choice of PID. `not-found` means
ask for another name or ID, never invent one. Follow `nextOffset` to read more
summaries; `sourceIncomplete` warns that the server list is incomplete. Login or
network errors are not an empty world list. Do not create a world just because
no name matched. After switching, verify world_status before editing.

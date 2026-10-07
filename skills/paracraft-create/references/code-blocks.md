# 代码方块：从场景到可玩的交互

用于代码方块、角色行为、点击/按键交互、对话、收集、倒计时、解谜和小游戏。保持原生 CodeBlock、MovieClip、角色、触发器和源代码可编辑。普通原生电路用 [circuits.md](circuits.md)；录制电影用 [filmmaking.md](filmmaking.md)。需要玩法组合时读 [codeblock-patterns.md](codeblock-patterns.md)，寻找教学依据时读 [codeblock-lessons.md](codeblock-lessons.md)。

跨场景、角色、规则与电影的完整作品先读 [game-engine.md](game-engine.md)。
它负责引擎部件组合；本文负责代码方块的原生运行契约。

## 少调用、少返回的创建与验收

- 现成的收集游戏 + 巡逻/跟随 NPC：`template_info {template:"codeblock_playground"}` → `run_template`。请求携带 `templateHash`、`expectedIdentity`、`requestId`，需要保留生成器时传 `saveSource:true`。创建结果含站点和相机坐标；按 `tokens → host → npc` 激活。模板会导出一个世界本地模型，默认不激活、不保存世界。
- 从需求选资料：通用运行规则读本文；设计新玩法再读 patterns；找 F1/530 原例才读 lessons；修改模板源代码才加载完整 Lua。不要每次加载全部教学或重复抄写生成器。
- 原生开发验收可在一次 CLI `run_npl_code` 中汇总游戏状态、克隆数和 NPC 状态，仅返回 `phase/score/epoch/count` 和失败原因；这是原生开发接口，不能作为通用创作 MCP action 发送。验收无需返回整段代码或共享表；修改已有程序时仍需 protected read/update 的完整 `expectedCode`。
- 等待行为完成采用有上限的递增间隔，如 150 → 225 → 338 ms，最高 1 秒。真实倒计时仍等它自然结束；读状态的次数不应随每帧增长。超时恢复原 job，不重建场景。
- 原生 `Actor:OnClick` 会排队执行事件；同一段原生代码中触发后立即读数，可能仍是旧状态。跨一次有界观测确认效果。批量点击应另有分时重复点击测试，不能只依赖一批 200 次都不重复计分。
- 保存重开只用于用户要求的保存验收或自建的专用测试世界。刷新 session，比较代码哈希、MovieClip 关联、模型/缩放、拉杆、源文件及导出文件；再实际启动一局。自带颜色的 `.x` 模型可忽略引擎补上的默认角色皮肤字段；自定义换肤角色必须验收皮肤。

## 先定义玩家能做什么

把需求写成可观察的交互契约：输入 → 条件 → 状态变化 → 反馈 → 结束/重置。例如“点击开始，在 20 秒内点完 5 个目标；每个目标只算一次；全部收集成功，超时失败；重开清空上局对象”。简单对话不必套完整游戏框架；多角色玩法再分控制器、角色和 UI。

选择与任务匹配的角色和反馈。教学中的青蛙、方块和固定位置只说明原理，不能当作所有作品的默认美术或地点。角色需要骨骼动画时结合 [characters.md](characters.md) / [animation.md](animation.md)；代码的行为控制与模型的动画片段是两层。

## 区分三种执行环境

| 环境 | 用途 | 不具备的隐含条件 |
|---|---|---|
| 物理 CodeBlock（219） | 世界中长期可编辑、可用拉杆启动的交互程序 | 放下方块不等于有演员，也不等于已经运行 |
| `run_code` 虚拟 CodeBlock | `createScene` 建造、可等待的短期试验 | 不自动绑定旁边电影的演员；作业完成不代表物理代码已经启动 |
| `run_npl_code` 原生 NPL | 开发环境检查实体、触发原生事件、读取运行状态 | 同步执行，不能直接使用代码方块的 `wait()` 或无限循环 |

在 Keepwork 中先 `help` 发现动作，再读指定动作 schema。原生 API 的权威操作契约由 `read_official_wiki` 的 `creation.md`、`code-block.md`、`animation.md` 提供。不能把内部 Lua 方法写成不存在的 MCP 动作。主技能的世界身份、聊天上下文、世界 AGENTS 和文档流程仍适用。

## 原生角色装配

一个独立角色站通常由 **拉杆 → 代码方块 ↔ 电影方块 → 一个有名字的演员** 组成。使用返回的场地原点和绝对位置，避开已有电影与相连代码块。

- 代码方块寻找同一 Y 层四个水平方向紧邻的 MovieClip；也可沿相连代码方块寻找电影，当前实现搜索深度上限 16。不是“16 格内任意位置最近的电影”。
- 同一个电影周围的多个代码块可能共享演员。可刻意让旋转与上下浮动并行，但避免两个写入者同时修改同一位置或同一动画通道。
- 给每个模块的 CodeBlock display name、电影演员 name、广播前缀和共享状态键取唯一名称。530 中反复出现 `frog`，迁移时不能依靠这个名字唯一定位。
- `scene:movie`、`scene:actor` 创建真实电影与 TimeSeriesNPC；在新建的自有代码单元中，用 `scene:editEntity(绝对位置, callback)` 设置 display name 和 `SetNPLCode(source)`。该回调不让出协程。已有代码用下述保护性编辑流程。
- `scene:actor` 的 `filename` 使用已验证的世界内 `.x` / `.bmax` 资产路径。教学别名如 `frog` 不等于 helper 接受的文件路径。微体素角色可用 `exportVoxelX` 导出可渲染网格，再创建演员；把含微体素载体的通用 block template 当作角色 BMax 可能得到空几何。先检查能力 `voxelMeshExport`。

可运行的完整建造源码：[codeblock-playground.lua](../examples/codeblock-playground.lua)。它自动选址，创建三个分离的角色站与一个 0.75 × 1.5 米玩具角色网格。保留模型源、电影、物理代码和拉杆；返回各自的坐标、演员名、状态键和独立视角。它会写世界内网格资产，但**不激活角色、不保存原生世界**。适配美术后再用在用户作品中。

该示例的默认流程：依次打开 `tokens`、`host`、`npc` 的拉杆；点击主持人开始/重开限时收集；点击蓝色目标计分；点击 NPC 在巡逻、跟随主持人、等待之间切换。跟随玩家可把目标改成 `@p`；要加障碍行走、距离滞回和活动范围时读 [codeblock-patterns.md](codeblock-patterns.md)。示例里的平台、初始坐标与数量为演示参数，不是玩法限制。

## 编辑与启动分开

已有世界先 `analyze_world`，按 code/movie 与区域筛选，再用 `read_scene_object(details:true)` 看源码、语言、原生关联与只读/镜像标记。大世界按模块查看，不能通过全文标题或示例坐标猜目标。

保护性源码编辑有两条正式路径：

1. `run_command` 的 `params.codeBlock` 使用 `operation:"list"/"read"/"update"`。读后保留真实 `position`、`worldPath` 和完整源；更新提供 `expectedCode` 与新 `code`，再读回。
2. `world_files` 列出 `_codeblocks_/`，使用真实返回路径；读后写入完整 `expectedContent` 和新内容，带 `expectedIdentity`。不能靠捏造文件名创建代码方块。

冲突就重新读取，镜像代码编辑实际源文件，不能用特权 NPL 绕过只读或编辑模式检查。写入成功、编译成功、绑定成功、启动成功和玩法正确分别验收。

启动使用作品设计的原生拉杆或编辑器。开发测试可通过 `run_npl_code` 对已记录的拉杆调用 `OnClick(x,y,z,"left")`，下一次请求检查 `EntityCode:IsPowered()`、`GetCodeBlock():IsLoaded()`、`GetActor()` 以及 `FindNearByMovieEntity()` 的实际位置。直接 `Restart()` 只验证脚本，不能证明拉杆接线。没有原生执行能力的环境应如实保留手动激活环节，不虚构动作。

热更新先关输入电源并观测代码停止，再保护性更新、重新上电和观测稳定启动。
拉杆控制状态与 `EntityCode:IsPowered()` 的调度状态不一定同一时刻变化；测试工具
应读取原生拉杆当前状态来决定是否切换，并等待代码的 powered/loaded/actor 一致，
不能把尚未更新的 `IsPowered()` 当作拉杆方向，否则连续修改可能反向切换电源。
原生 `BroadcastKeyPressedEvent` 可以验证键名映射与按键事件分派，但不能证明真实
硬件键盘、焦点或系统快捷键冲突已经测试。

停止有各自范围：关闭物理拉杆停止那组脚本；虚拟作业用 `code_job operation:"cancel"`。`exit()` 会停止相连代码块，`terminate()` 只终止当前协程，均不应充当普通小游戏的“本局结束”。局末切换游戏状态并清理本局对象。

## 必须掌握的运行语义

| 主题 | 原生行为与创作决策 |
|---|---|
| 时间 | `wait`、移动 duration、`getTimer` 是秒；`getTimer` 是该代码块启动后的本地时钟，不能与另一个代码块的 deadline 直接比较。`play(0,1000)` 的电影时间是毫秒；`scene:keyframe` 是秒。规则时间由同一控制器判定，别按渲染帧累加时间 |
| 角度 | CodeBlock 的 `turn/turnTo` 用度；`createScene` 模型 facing 与引擎属性可能用弧度，勿混用 |
| 位置 | `getPos/setPos` 用浮点 block 坐标；`getX/getY/getZ` 与移动方式要查相应 API；外部相机用 `scene:toWorld/cameraPoint` 转换。2D 图层演员有自己的坐标语义 |
| 移动 | `move` 是脚本位移；`walk/walkForward` 使用角色物理/行走，可能被墙挡住。不能声称移动插值就是寻路；目标不可达要有超时/退回策略 |
| 让出执行 | 编译器会插入让出检查，但轮询仍宜有 `wait(0.05~0.1)`。不要把教学中的逐帧 `turn(1)` 当作稳定的度/秒 |
| 感知半径 | `sentientRadius>0` 时，玩家太远会使 `wait` 暂停行为；远距离后台控制器需要明确处理，示例设 0。距离外暂停不等于程序报错 |
| 数据 | `_G`、`set/get` 是世界代码全局；普通变量是代码环境数据；顶层 `local` 被回调闭包共享，克隆不自动得到独立副本。单个克隆的 ID、血量、轮次放 actor value 或唯一 ID 表 |
| 克隆 | 先注册 `registerCloneEvent`，再 `clone(name,msg)`；克隆演员并走克隆回调，不会重新执行源文件顶层。`delete()` 删除当前演员；模板隐藏，克隆回调显式 `show()` |
| 广播 | 普通广播作用于所有匹配接收器及其演员/克隆，消息要带模块前缀、轮次或目标 ID。`broadcastAndWait` 只用于稳定、一定会返回的处理器；事件可能在监听器就绪前丢失。当前引擎在事件容器存在但接收器已注销时也可能不回调；关闭/复位不要靠无限等待广播完成 |
| 重复事件 | 一般 CodeEvent 会先停止同一演员的前一次同类回调再运行新回调。在回调开头写 `if busy then return end` 无法保护已被停止的旧协程。原生按键注册显式关闭 stop-last，长处理器可能并发；仍应只改请求，把长任务放单一 worker。不要假定所有事件类型拥有相同重入语义 |
| tick | `registerTickEvent` 上一次没结束会跳过该 tick，不是承诺固定间隔；短任务适用，游戏钟仍用时间差 |
| 对话 | `ask` 等待输入；文本答案是字符串，按钮答案是从 1 开始的索引，取消可为 nil；同步返回值最清楚。`answer` 为共享全局，多个对话需单一负责人 |
| 清理 | `registerStopEvent` 的自动让出被禁用，保持短小、同步、无 `wait`。复位分数、克隆、任务进度、UI、音效、挂接与输出信号，范围限自己所有的资源 |

## 验收与交付

先验收正向路径，再测试重复点击、提前重开、超时、停止中断和重新启动；多角色要测试监听器未准备好以及旧轮次消息。实际状态、演员数量、运动前后位置和时间线都是证据。脚本直接设置 `phase="won"` 不是胜利路径测试。

原生 `Actor:OnClick` 测试能证明原生事件分派和程序行为，不能证明屏幕拾取命中；需要真实点击体验验收时，另做原生输入/人工交互检查。看图用于确认角色可见、位置、颜色和反馈，不代替行为验收。用 CLI 独立相机与 `tail_log`；普通调试不自动操作 8099 浏览器控制台。

把模块职责、代码/电影/触发器位置、演员名、共享状态与事件协议、玩法入口、复位方式、测试结果记入世界直接 `docs/codeblocks.md` 或专题页，并更新 `docs/changes.md`。保存/重开在用户要求保存时执行，重新查身份并核对真实源码、模型、电影演员与启动链。不要把本次内存行为通过写成“世界已保存”。

实现依据（相对 Paracraft 安装根，按需阅读）：`script/apps/Aries/Creator/Game/Entity/EntityCode.lua`、`Code/CodeEvent.lua`、`Code/CodeCoroutine.lua`、`Code/CodeGlobals.lua`、`Code/CodeAPI_{Events,Control,MotionLooks,Sensing,Data}.lua`；API 教学实例还在 `Code/CodeBlocklyDef/` 各分类文件的 `examples` 字段。

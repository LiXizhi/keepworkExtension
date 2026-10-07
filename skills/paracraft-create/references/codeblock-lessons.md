# F1 与 project 530 的代码方块学习地图

这里记录原生教学的定位线索与可迁移知识，不执行世界里的未知源码，也不把教学世界当作施工场地。先按 [code-blocks.md](code-blocks.md) 建立演员与运行环境，再按 [codeblock-patterns.md](codeblock-patterns.md) 组合行为。

## F1 教学来源

2026-10-07 在本机 Paracraft 资源中索引了 **41 个**“编程教学”条目。入口是 `script/apps/Aries/Creator/Game/Tasks/HelpPage.lua` → `BuildQuestProvider.lua` → `config/Aries/creator/blocktemplates/buildingtask/programming/`；该目录 `info.xml` 标题为“编程教学”。不是 `Tasks/Help/HelpConfig.lua` 的产品菜单说明。

每个目录 `D` 对应 `D/D.xml`（Task 标题、说明、步骤、教学宏）和 `D/D.blocks.xml`（起始模板、实体源码、电影轨道）。前几个入门模板会留下空代码，教学在宏操作中输入；不能把空模板判为课程缺失，也不能认为每个模板都已包含最终答案。有的 `.blocks.xml` 实际为 ZIP；查看文件头后解压到临时目录。XML 内 `<pe:blocks>` 是嵌套 NPL 数据，不是纯数字坐标列表；不要用执行任意 Lua 的方式解析下载内容。只需改进某一行为时读取对应条目与 API 示例即可，不把全部宏录制步骤装进上下文。

以下保留实际目录名，包括两个 `08` 和缺少的数字；不要根据序号拼不存在的路径。

| 目录 | 教学名称 | 可复用知识/依赖 |
|---|---|---|
| `01MoveForward` | 让角色向前行走 | MovieClip 演员、名称、初始位置与前进 |
| `02Turn` | 让角色转身 | 转弯与重复，组合巡逻路径 |
| `03KeepTurning` | 一直旋转的物品 | 旋转循环；改用时间确定速度 |
| `04OnClickSay` | 点击人物说话 | 演员点击与头顶文字 |
| `05Ask` | 交互式对话框 | 分支对话与选项 |
| `06SetBlock` | 放置方块 | 演员位置与目标方块 |
| `07RandomWalk` | 随机行走的人物 | 随机路程和朝向；实际作品限定活动区 |
| `08CreateDeleteBlock` | 创建和删除方块 | `setBlock`，0 为空气；原地恢复需保存原值 |
| `08EventControl` | 遥控人物机关 | 两演员广播“开门”，接收者走到压力板后返回 |
| `09BalloonUp` | 气球升起 | 克隆回调、随机出生、上升、寿命结束 `delete` |
| `10RingEffectAnim` | 光圈旋转加位移 | 两代码块共享演员，不同通道并行 |
| `11ChangeDayTime` | 改变时间 | `/time` 与循环；修改世界环境需符合任务范围 |
| `12moveAlongWalls` | 沿墙壁行走 | 小步检测障碍、退回转向；不是通用迷宫求解算法 |
| `13SpaceKeyToTalk` | 按空格对话 | 按键与距离门槛；先验证模型动作 ID |
| `14facingPlayer` | 一直面向玩家 | `turnTo("@p")` 和 sentientRadius |
| `15twoActors` | 2个角色 | 命名 `p1`，另一个演员按距离跟随 |
| `16followPet` | 永远跟随主角 | `wait(0.1)`、转向玩家、距离大于 3 时行走 |
| `17controlPlayer` | 控制主角运动 | `becomeAgent("@p")`；会接管玩家，只在需求需要时用 |
| `18actorAnimation` | 角色动画 | 点击 `play(0,1000)`，依赖预录电影动作 |
| `19wheelAnimation` | 电风扇 | 骨骼模型、`playSpeed`、`playLoop` |
| `20hideAndTransparent` | 隐藏与半透明 | opacity 0..1 与 hide/show 不同 |
| `21clock` | 时钟 | 两个克隆+模板，按电影区间区分指针，按计时器旋转 |
| `23cmd_shapes` | 形状命令 | `/goto /take /circle /sphere` 依赖玩家/手持方块；一般场景改用有界 helper |
| `24elevator` | 电梯 | 运动平台、停站检测、`runForActor` 与 link 挂接 |
| `26SetPos` | 设置角色位置 | 绝对位置；迁移时转换原点，不复制教学坐标 |
| `27ShowAndHide` | 显示与隐藏角色 | 角色可见性控制 |
| `28ControlLightvalue` | 控制灯的亮度 | `/block ... lightvalue`；检查命令作用范围 |
| `29ProgrammableCamera` | 编程控制摄影机 | focus/camera；仅作品需要相机控制时使用 |
| `30AutoGate` | 自动门 | 双门片相反位移；4/7 距离阈值避免抖动 |
| `31CircuitsAndLights` | 电路与电灯 | 代码输出信号，连接原生中继器/负载 |
| `32SwitchImage` | 切换图片 | 点击切换 `movieactor`；依赖电影的演员槽位 |
| `33CodedLock` | 密码锁 | ask 判答案、双门广播、远离后关闭 |
| `34PlaySound` | 播放声音 | 点击反馈音效 |
| `35MirroringAndReplication` | 镜像与复制 | 对称模型建造，不是独立游戏程序 |
| `36SpecialEffects` | 添加特效 | 原生特效角色，需要对应素材 |
| `37AreaPlacementAndDeletion` | 区域放置与删除 | 启动放置、停止清理；实际作品只恢复自己改的格子 |
| `38SwitchBackgroundMusic` | 切换背景音乐 | 上一首/下一首、共享索引、按键停止 |
| `39CodeBlockControlLayerRoles` | 代码方块控制图层角色 | 多槽位切换模拟图层动画 |
| `40CurtainWithBonesAdded` | 添加骨骼的窗帘 | o/c 按键播放两个毫秒区间，模型骨骼前提 |
| `CountBlock` | CountBlock | 区域方块计数的教学入口；按当前模板/宏继续读 |
| `SendEntityEvent` | SendEntityEvent | 定义实体事件并通过命令发送的教学入口 |

上表来自 Task 元数据、模板内可读 cmd 与实现核对。宏教学与所有资产尚未逐课回放；不要将本索引说成 41 课的运行测试报告。API 自带小例子可在 `Code/CodeBlocklyDef/CodeBlocklyDef_*.lua` 的 `examples` 中按函数查找，事件/运动/感知的最终语义以当前运行时为准。

## Project 530：CodeBlockTest

2026-10-07 单独打开 project **530**，读世界 AGENTS（当时没有该文件，分析保持只读），用 `analyze_world` 索引到 **141 个已加载代码方块**。对目录做调用名/短预览分类，再完整阅读下面 **23 个**相关代码对象。原生关联由 `FindNearByMovieEntity`/分析结果确认，未启动这些历史程序。保存区域为 `blockWorld.lastsave/37_37.region.xml`；地形未解码、未加载区域和全世界全部行为不在结论范围。

坐标是该次观察的**绝对 block 坐标**，用于重新查找，不是新建作品的坐标模板。例子的 name 有重复；重开后重新分析并核对源码/指纹，不复用旧 ref。默认语言、Python、Haqi、自定义语言、故意的语法/运行错误、串口/MQTT/登录/联网等测试混在同一个世界，不能一键运行全世界。

| 区域/定位 | 读取到的实际结构 | 迁移价值 |
|---|---|---|
| `(19201,5,19126)` `placeItem` | 校验空位，递增 step，设置共享 new_x/new_z，克隆 black/white，再广播 itemPlaced | 把输入校验和视图生成分开；新设计改为消息传坐标 |
| `(19201,5,19127)` `board` | 10×10 data 表、winCount=5，克隆棋盘格 | 规则参数化；原代码 `/mode game` 不应无条件复制 |
| `(19202,5,19127)` `black` | 克隆是棋子，模板是当前回合的鼠标预览，restart 删除 isItem 克隆 | 模板与实例分工；white 同组条目已索引，未在这次完整读取 |
| `(19204,5,19127)` `judger` | itemPlaced 后检查横、竖、两斜方向，广播 win | 棋盘逻辑与显示独立，扩展 N 连子 |
| `(19204,5,19126)` `onWin` | 显示赢家，等待 3 秒，清 data/step，广播 restart | 一轮结束与重置；补终局锁、和局和旧轮次隔离 |
| `(19201,5,19155)` `frog` | 碰 block 171 或 box 后 bounce | 弹球/障碍反馈；要定义速度和碰撞边界 |
| `(19201,5,19163)` `frog` | 鼠标近时跟随鼠标；玩家近时跟随玩家；远时传送 | 多条件行为优先级；任务不需要传送时去掉该分支 |
| `(19201,5,19189)` + `(19202,5,19189)` | jump 的 `broadcastAndWait` 与有限跳跃接收器 | 等演员完成再继续剧情；两个各自绑定电影 |
| `(19207,5,19180)` `frog` + `(19208,5,19180)` `dog` | 按名字/组号监听碰撞；dog 设置碰撞体与组 3，并显式 broadcastCollision | 碰撞组和克隆交互，避免“注册即自动检测”的假设 |
| `(19211,5,19253)` `elevator` | 两个并行循环管运行/登乘，按键解除 link | 状态化载客平台；增加停止清理和异常下车 |
| `(19213,5,19238)` `testclone` + `(19220,5,19237)` `testInstance` | 一个顶层 local i，被克隆回调闭包共享；另一个普通 i 为环境变量 | 观察共享状态；单实例状态用 actor value |
| `(19214,5,19188)` | 文本 A/B 后，再问四个按钮，比较 answer==1/2 | 文本答案与按钮索引区别，处理取消 |
| `(19219,5,19175)` | A 等待 B，B 结束后 A 结束 | 有限广播链和等待顺序 |
| `(19219,5,19188)` | 第二个 move 中断第一个，最后零时长位移停止 | 同一位置通道竞争；使用单一运动 owner |
| `(19220,5,19243)` | states 表、run 新状态、terminate 当前协程 | 状态切换概念；通常先用更易验证的单循环 FSM |
| `(19222,5,19203)` | 空格跳跃、mouse_buttons、mouse_wheel | 输入路由；键盘/鼠标信息类型不同 |
| `(19227,5,19203)` | any 和 block 10 点击，读取 msg.x/y/z/side/blockid | 空间按钮/棋盘输入；增加作用区域过滤 |
| `(19229,5,19175)` | ask 判密码，正确时 setOutput(15) | 软件逻辑与原生电路接口 |
| `(19229,5,19239)` | tick 处理器内 wait(0.3) 再 say | tick 跳过尚未完成处理器；不按 tick 次数计真实时间 |
| `(19240,5,19194)` | rendercode 绘制透明矩形并接收点击 | 看不见的图层仍可能参与交互；核对遮挡与命中区域 |

棋盘模块的电影关联：board/placeItem → `(19201,5,19128)`，black → `(19202,5,19128)`，judger/onWin → `(19204,5,19128)`。这说明“多个代码方块共享同一演员”是原生用法，而不是每个代码块天然拥有一个独立角色。

## 研究结论怎样变成创作

读取教学时提取五件事：启动入口、演员/资产前提、状态所有者、事件/数据接口、停止/重置。再把它们映射到当前玩法。例如 F1 气球的“克隆—移动—删除”可改为目标生成与销毁；530 棋盘的“数据—裁判—视图”可改为答题、关卡或拼图；F1 自动门的双阈值可改为 NPC 接近/远离行为。保留语义，重新设计位置、美术、状态边界和验收条件。

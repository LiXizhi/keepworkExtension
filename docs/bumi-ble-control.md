# Bumi 机器人 BLE 控制实现

本文整理 `apps/aichat-rust` 中 Bumi 控制窗口的实现方式、BLE 协议、已接入指令、安全约束和验证方法。协议来源为 Noetix 3.2.2 Android 客户端（含 Flutter `libapp.so`）的静态逆向结果，安全要求、坐标系与工作模式参考[官方文档](https://web.noetixrobotics.com/docs/en/)及[官方 HighController 示例](https://github.com/Noetix-Robotics/noetix_sdk_bumi/blob/main/examples/py/test_high.py)。

## 1. 功能与入口

支持平台：macOS、Windows 的 Tauri 桌面端。

入口：

- macOS / Windows 菜单：「视图 → Bumi 机器人…」
- 系统托盘：「Bumi 机器人…」

当前功能：

- 扫描、选择、连接和断开 Bumi 设备；
- 查询电量和运行状态码；
- 按需查看电脑写出的 GATT 帧和机器人返回的通知，分别统计发送与接收；
- 手动选择行走或全身行走；
- 拖动中心摇杆连续调节前后与转向，或用四周的方向按钮低速点动；
- 一键起身和一键收纳；
- 跳舞、挥手、握手和欢呼；
- 输入 UTF-8 文本让机器人说话；
- 设置 0–100% 音量；
- 跟随桌面端深浅色主题。

这个窗口通过蓝牙直接控制所选设备，扫描、连接、收发诊断及动作都由用户触发。

## 2. 实现结构

控制窗口是一个独立的本地 Tauri Webview，前端不直接访问蓝牙。所有操作经唯一 IPC 命令 `bumi_control` 进入 Rust 后端，再由 `btleplug 0.13.5` 调用系统 BLE 能力。

```text
本地 bumi-control.html / TypeScript
              |
              | bumi_control IPC
              v
Rust 请求校验与窗口所有权管理
              |
              | btleplug
              v
macOS CoreBluetooth / Windows WinRT BLE
              |
              v
Bumi GATT 服务
```

主要文件：

| 文件 | 职责 |
| --- | --- |
| `apps/aichat-rust/bumi-control.html` | 本地窗口结构、CSP 和操作说明 |
| `apps/aichat-rust/src/bumi-control.ts` | 设备选择、按钮状态、移动队列、安全确认和 IPC 调用 |
| `apps/aichat-rust/src/bumi-control.css` | 窗口布局及深浅色主题 |
| `apps/aichat-rust/src-tauri/src/app/bumi.rs` | 窗口生命周期、请求模型、页面来源校验和快照 |
| `apps/aichat-rust/src-tauri/src/app/bumi/bluetooth.rs` | 扫描、连接、GATT、分包写入、通知监听、窗口定向事件和停止保护 |
| `apps/aichat-rust/src-tauri/src/app/bumi/protocol.rs` | BLE 指令编码、帧封装和响应解析 |
| `apps/aichat-rust/src-tauri/capabilities/bumi-control.json` | 仅授予 `bumi-control` 窗口本地 IPC 权限 |
| `apps/aichat-rust/src-tauri/permissions/desktop-commands.toml` | `allow-bumi-control` 权限定义 |
| `apps/aichat-rust/tests/bumi-control.test.cjs` | 菜单、ACL、打包、界面和安全约束回归测试 |

IPC 请求形状：

```json
{ "operation": "scan" }
{ "operation": "connect", "id": "<系统设备 ID>" }
{ "operation": "disconnect" }
{ "operation": "listen", "enabled": true }
{ "operation": "send", "command": { "action": "battery" } }
{ "operation": "send", "command": { "action": "move", "vx": 40, "vyaw": 0 } }
{ "operation": "send", "command": { "action": "speak", "text": "你好" } }
```

快照包含 `available`、`devices`、`connected`、`battery`、`status`、`moving`、`locomotionMode`、`walkMode` 和 `listening`。`status` 保留上一次查询得到的原始 BLE 状态码。Bumi 控制窗口按 NOETIX Run 3.2.2 的蓝牙状态表及该机型的模式名称，显示未启动（0）、准备（1）、行走（2）、全身行走（3）、保护（26）和失能（30），其他值显示原始编号。选择步态后可再次查询机器人上报的状态。

`locomotionMode` 记录本次连接最近成功写入的步态请求。`"walk"` 对应行走，原有值 `"run"` 在 Bumi/NTXB 界面对应全身行走，清除选择后为 `null`。机器人是否进入相应步态仍需确认。保留的 `walkMode` 仅在选择 `"walk"` 时为 `true`。旧快照缺少 `locomotionMode` 时，客户端可用 `walkMode: true` 识别行走选择。

## 3. BLE 发现与连接

### 3.1 扫描过滤

官方客户端不使用硬件级服务 UUID 过滤，而是按名称匹配。当前桌面端接受：

- 名称中包含 `Bumi`，不区分大小写；
- 名称以 `NTXB` 开头，不区分大小写。

已实测设备示例：

```text
广播名称：NTXB12CBM2656CB01A0039
macOS UUID：B4462ABA-A453-1699-B8B2-7D168E61652B
广播服务：6E400001-B5A3-F393-E0A9-E50E24DCCA9E
```

macOS UUID 是系统分配的 CoreBluetooth 标识，不是机器人广播名称，也不应写成固定硬件地址。

NTXB 设备广播较稀疏，实测曾在扫描第 17 秒才首次出现。因此桌面端每次扫描持续 **20 秒**，而不是只等待数秒。设备被手机 App 或其他客户端连接后通常会停止广播。

### 3.2 GATT 配置

| 用途 | UUID |
| --- | --- |
| 服务 | `061e8f00-8a56-11f0-a62c-00155dff3a7e` |
| 通知，机器人 → 电脑 | `061e8f01-8a56-11f0-a62c-00155dff3a7e` |
| 写入，电脑 → 机器人 | `061e8f02-8a56-11f0-a62c-00155dff3a7e` |
| CCCD | `00002902-0000-1000-8000-00805f9b34fb` |

连接流程：

1. 用户从最近一次扫描结果中选择设备；
2. 连接并发现服务；
3. 校验服务、写入特征和通知特征；
4. 优先使用 Write With Response，否则使用 Write Without Response；
5. 订阅通知特征；
6. 建立当前窗口拥有的连接会话。

macOS 的蓝牙用途说明位于 `apps/aichat-rust/src-tauri/Info.plist`。修改权限或能力配置后，需要重启正在运行的开发桌面壳；Vite 页面热更新不会重新加载原生 ACL。

## 4. 数据帧格式

写入和通知均使用同一个包装：

```text
55 AA <LEN> <INNER...> <LEN>
```

- 前两个字节固定为 `55 AA`；
- `LEN = INNER 长度 + 4`；
- 最后一个字节重复 `LEN`，用于完整性检查；
- 它不是额外的求和或 CRC 校验；
- `INNER` 的第一个字节为操作码。

例如查询电量：

```text
INNER: 22
FRAME: 55 AA 05 22 05
```

发送时按 **20 字节**分包，兼容默认 BLE MTU。Write Without Response 的多包发送之间等待 15 ms；接收电量/状态查询时等待匹配的通知帧，查询超时为 4 秒。

## 5. 已接入指令

下表的“完整帧”包含 `55 AA`、长度和尾部字节。

| 功能 | IPC `action` | INNER | 完整帧或格式 |
| --- | --- | --- | --- |
| 查询电量 | `battery` | `22` | `55 AA 05 22 05` |
| 查询状态 | `status` | `31` | `55 AA 05 31 05` |
| 请求行走模式 | `walk` | `12 01` | `55 AA 06 12 01 06` |
| 请求全身行走（Bumi/NTXB） | `run` | `12 02` | `55 AA 06 12 02 06` |
| 跳舞 | `dance` | `1E 01` | `55 AA 06 1E 01 06` |
| 挥手 | `wave` | `12 03` | `55 AA 06 12 03 06` |
| 握手 | `handshake` | `12 04` | `55 AA 06 12 04 06` |
| 欢呼 | `cheer` | `12 05` | `55 AA 06 12 05 06` |
| 一键起身 | `standUp` | `12 08` | `55 AA 06 12 08 06` |
| 一键收纳 | `standToFall` | `12 09` | `55 AA 06 12 09 06` |
| 移动 | `move` | `13 <vx> <vyaw> <vy=00>` | `55 AA 08 13 <vx> <vyaw> 00 08` |
| 文字说话 | `speak` | `16 <UTF-8 文本>` | 长度随文本变化 |
| 设置音量 | `volume` | `32 <0…100>` | 例如 75%：`55 AA 06 32 4B 06` |

`Dance` 使用 `DANCE_ID = 0x1E` 加舞蹈编号 `01`，不是只发送进入舞蹈模式的 `KEYSTROKE 0`。

### 5.1 方向坐标与移动帧

官方 DDS 接口 `publish_cmd(x, y, z, ...)` 把正 `x` 定义为前进、正 `y` 为左移、正 `z/yaw` 为左转。SDK 示例以 `publish_cmd(x, 0, yaw, ...)` 控制纵向和转向。桌面端同样提供“前进／后退”和“左转／右转”，侧向速度固定为零。[Bumi 官方文档](https://web.noetixrobotics.com/docs/en/) · [HighController 示例](https://github.com/Noetix-Robotics/noetix_sdk_bumi/blob/main/examples/py/test_high.py)

官方 App 的实际蓝牙发送路径是 Flutter 中的 `RobotCommandSender.sendJoy(vx, vy, vyaw)` → `BleCommand.createMoveCommand`，载荷为 `0x13` 加 **3 个**有符号字节：`round(vx·127)`、`round(vyaw·127)`、`round(vy·127)`，各自限制在 ±127。官方编程接口中 `forward` = `sendJoy(1, 0, 0)`、`backward` = `(-1, 0, 0)`、`turnLeft` = `(0, 0, 1)`、`turnRight` = `(0, 0, -1)`。

早期实现以 Java 层 `TcpConversionToBleUtils` 的两个速度字节为依据，组装出 7 字节帧。当前编码与下表中的固定字节可通过协议测试核对。目标固件收到这些字节后的动作需用真机验证。

在圆形摇杆内，以中心为原点，水平向右为正 `dx`，竖直向下为正 `dy`，半径为 1。桌面端将超出圆周的拖动限制在圆周上，保持拖动方向，再按 `vx = round(-dy × 127)`、`vyaw = round(-dx × 127)` 计算两个轴。往外拖动会逐步加大幅度；向左上方拖动时，前进和左转同时生效于同一条指令。摇杆回到中心或松手时两轴归零。

四周方向按钮保留 `40/127` 的低速点动幅度，约为满行程的 31%。正负 40 按二进制补码编码为 `0x28` 和 `0xD8`。协议帧没有距离参数。若要确认实际走了多远，可在平地标出起点，松手并待机器人停止后量出位移。

| 操作 | `vx` | `vyaw` | 完整帧 |
| --- | ---: | ---: | --- |
| 摇杆正前满推 | 127 | 0 | `55 AA 08 13 7F 00 00 08` |
| 摇杆正后满推 | -127 | 0 | `55 AA 08 13 81 00 00 08` |
| 摇杆左上，`(dx, dy) = (-0.3, -0.4)` | 51 | 38 | `55 AA 08 13 33 26 00 08` |
| 按钮前进 | 40 | 0 | `55 AA 08 13 28 00 00 08` |
| 按钮后退 | -40 | 0 | `55 AA 08 13 D8 00 00 08` |
| 按钮原地左转 | 0 | 40 | `55 AA 08 13 00 28 00 08` |
| 按钮原地右转 | 0 | -40 | `55 AA 08 13 00 D8 00 08` |
| 停止 | 0 | 0 | `55 AA 08 13 00 00 00 08` |

### 5.2 文字说话

文本使用 UTF-8 直接跟在 `0x16` 后。当前限制为 **120 个 UTF-8 字节**，不是 120 个汉字；40 个中文汉字通常已占 120 字节。

“你好”的完整帧：

```text
55 AA 0B 16 E4 BD A0 E5 A5 BD 0B
```

TTS 没有播放完成回执。“说话指令已发送”只表示 BLE 写入完成，不证明机器人已经发声。实际声音还受机器人音量、扬声器输出状态、语音功能和网络/语音服务状态影响。音量滑块是待设置值，不是从机器人读取的当前音量。

## 6. 蓝牙消息监听

连接设备后点击“开始监听”，面板分别记录本机通过 GATT 写出的帧与机器人返回的通知。开启监听只开始记录。要在机器人静止时检查双向通信，点击一次“查询电量”或“查询状态”。

| 现场现象 | 可以确认的信息 |
| --- | --- |
| 已开启监听，尚未操作，发送和接收均为零 | 当前尚无收发记录。 |
| 点击“查询电量”，出现发送 `0x22` 和接收 `0x26`，电量更新 | 本次查询完成了从电脑到机器人再返回窗口的整个过程。查询状态的对应操作码为 `0x31` 和 `0x51`。 |
| 出现查询发送记录，随后提示等候回包超时 | 本机完成了写入，期限内没有收到匹配的应答。若出现其他通知，可按操作码区分。 |
| 按住方向按钮时出现移动帧，松手后出现零速度帧 | 可核对本机写出的方向、幅度和停止顺序。相邻两帧中前一帧为非零速度时，面板显示两次原生 GATT 写入完成之间的毫秒数，包括最后一次移动到零速度的间隔。实际迈步、朝向与停止要在现场观察。 |

停止监听、断开连接、换窗口会话或关闭窗口都会取消监听任务。收发记录通过 `bumi:message` 定向投递到当前控制窗口，`bumi:listener` 通知监听状态变化。

每条记录包含方向及以下信息：

| 字段 | 含义 |
| --- | --- |
| `receivedAt` | 记录时间，RFC 3339 格式 |
| `size` | 原始字节数 |
| `hex` | 大写十六进制原始帧 |
| `opcode` | 从合法帧内提取的操作码，无法识别时为 `null` |
| `summary` | 电量、状态或已知识别结果；多分片消息保留分片序号 |
| `text` | 可解码的 UTF-8 文本，最多显示 512 个字符 |
| `truncated` | 原始帧是否因显示上限而截断 |

单个通知最多显示前 1024 字节，窗口保留最近 200 条记录。日志仅存在当前页面内存中。动态内容使用 `textContent` 显示。

“清空”只清除当前窗口日志，不影响机器人或后续监听。

## 7. 移动与动作安全状态

先让 Bumi 按操作说明完成起身，确认它在平坦地面上站稳，再点击“进入行走模式”。如果首次发送时机器人还在起身，可以等它站稳后手动重发行走模式指令。[Noetix Run App 使用说明，第 4 节](https://app-api.noetixrobotics.com/infoToUse.html)

用户提供的 iOS 竖屏截图显示“行走”“全身行走”两个模式和四向摇杆。两个模式的 BLE 操作码与摇杆坐标来自对 Android NOETIX Run 3.2.2 的离线核对。Bumi/NTXB 的行走使用 `12 01`，全身行走使用 `12 02`，两种步态都由同一摇杆控制。官方 App 在 BOOMY 机型上有独立的 `12 12` 路径；本窗口支持的 Bumi/NTXB 使用上表中的指令。iOS 截图只用于核对可见交互，本轮尚未记录 iOS 蓝牙数据或实机步态。

控制窗口成功写入 `walk` 或 `run` 后启用摇杆和低速点动按钮。BLE 写入成功只表示指令已发出，实际姿态和步态仍需现场确认。执行跳舞、挥手、握手、欢呼、起身或收纳后，窗口会清除选择。在重新选择模式之前，后端拒绝非零速度指令。

拖动摇杆时可以在同一次手势中改变幅度和方向；按下低速点动按钮则立即发送该方向的低速指令。持续按住时，窗口按官方 App 手动摇杆的 **100 毫秒固定周期**刷新。到点时若上一笔写入仍在进行，就跳过本次刷新，等到下一个周期再发送。一次只写一帧，错过的周期会丢弃，因此面板实测的写入完成间隔可能超过 100 毫秒。

松开按钮、取消指针、失去指针捕获、窗口失焦、页面隐藏，或点击“停止”，都会取消后续刷新并发送零速度。使用键盘时，可将焦点移到方向按钮，按住空格或回车，松键即停止。

若松手时上一帧还在发送，窗口会在写入完成后立即发零速度。移动指令写入异常也会触发一次零速度停止。停止结果未知时，界面提示用户断开连接。移动中切换到其他命令前，后端先发零速度。断开或关闭窗口时，如果后端仍记录有移动指令生效，它也会尝试发零速度。

## 8. 起身与收纳安全

### 一键起身

每次执行前确认：

- 机器人已开机并正面朝上平躺；
- 四肢自然放在腰部两侧，双腿伸直；
- 地面平坦、不打滑，脚底无异物；
- 周围 3m × 3m 内没有杂物或行人。

### 一键收纳

官方名称为“一键收纳”，不是让机器人自由倒下。每次执行前确认：

- 机器人当前处于站立姿态；
- 地面平坦、不打滑；
- 周围没有杂物或行人；
- 动作完成后立即将机器人扶稳并坐于地面。

## 9. 权限与窗口边界

- IPC 仅允许标签为 `bumi-control` 的本地窗口；
- 仅接受精确的 `/bumi-control.html`，拒绝查询参数、片段、用户信息和非预期端口；
- 开发来源仅允许调试构建中的 `http://127.0.0.1:1430`；
- 主窗口、宠物窗口和远程网页没有 `bumi_control` 权限；
- 机器人通知通过 `emit_to` 仅投递到 `bumi-control`，不广播到其他窗口；
- 禁止窗口导航到其他页面及打开新窗口；
- 关闭窗口会释放会话所有权并断开设备。

## 10. 验证

在 `apps/aichat-rust` 中执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib app::bumi --features dev-bins
node --test tests/bumi-control.test.cjs tests/bumi-motion.test.cjs
pnpm typecheck
pnpm build
```

协议测试覆盖：

- 所有固定指令帧；
- 前进、后退、左转、右转与零速度的官方 8 字节移动帧；
- 中文 TTS UTF-8 编码及 120 字节边界；
- 电量/状态通知解析；
- 监听消息的摘要、UTF-8 文本和分片信息；
- 非法帧头、长度和尾部校验；
- 本地页面来源限制。

界面测试覆盖菜单入口、独立 ACL、生产入口、方向输入、停止按钮、行走和全身行走模式请求、安全确认、说话输入、监听开关、200 条日志上限、窗口定向事件和主题同步。

真实机器人的移动、动作和声音仍需要在平坦、安全的环境中逐项现场验收；单元测试和生产构建不能替代物理动作验证。

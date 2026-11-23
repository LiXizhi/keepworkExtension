# Bumi 机器人 BLE 控制实现

本文整理 `apps/aichat-rust` 中 Bumi 控制窗口的实现方式、BLE 协议、已接入指令、安全约束和验证方法。协议来源为 Noetix 3.2.2 Android 客户端的静态逆向结果，安全要求参考[官方文档](https://web.noetixrobotics.com/docs/)。

## 1. 功能与入口

支持平台：macOS、Windows 的 Tauri 桌面端。

入口：

- macOS / Windows 菜单：「视图 → Bumi 机器人…」
- 系统托盘：「Bumi 机器人…」

当前功能：

- 扫描、选择、连接和断开 Bumi 设备；
- 查询电量和运行状态码；
- 进入行走模式；
- 低速前进、后退、原地左转和原地右转；
- 一键起身和一键收纳；
- 跳舞、挥手、握手和欢呼；
- 输入 UTF-8 文本让机器人说话；
- 设置 0–100% 音量；
- 跟随桌面端深浅色主题。

不包含 Wi-Fi 配网、连续语音对话、图传、OTA 或任意自定义指令。所有控制都由用户主动触发，不在后台自动连接或控制机器人。

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
| `apps/aichat-rust/src-tauri/src/app/bumi/bluetooth.rs` | 扫描、连接、GATT、分包写入、通知接收和停止保护 |
| `apps/aichat-rust/src-tauri/src/app/bumi/protocol.rs` | 指令编码、帧封装和响应解析 |
| `apps/aichat-rust/src-tauri/capabilities/bumi-control.json` | 仅授予 `bumi-control` 窗口本地 IPC 权限 |
| `apps/aichat-rust/src-tauri/permissions/desktop-commands.toml` | `allow-bumi-control` 权限定义 |
| `apps/aichat-rust/tests/bumi-control.test.cjs` | 菜单、ACL、打包、界面和安全约束回归测试 |

IPC 请求形状：

```json
{ "operation": "scan" }
{ "operation": "connect", "id": "<系统设备 ID>" }
{ "operation": "disconnect" }
{ "operation": "send", "command": { "action": "battery" } }
{ "operation": "send", "command": { "action": "move", "vx": 40, "vyaw": 0 } }
{ "operation": "send", "command": { "action": "speak", "text": "你好" } }
```

快照包含 `available`、`devices`、`connected`、`battery`、`status`、`moving` 和 `walkMode`。

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
| 进入行走模式 | `walk` | `12 01` | `55 AA 06 12 01 06` |
| 跳舞 | `dance` | `1E 01` | `55 AA 06 1E 01 06` |
| 挥手 | `wave` | `12 03` | `55 AA 06 12 03 06` |
| 握手 | `handshake` | `12 04` | `55 AA 06 12 04 06` |
| 欢呼 | `cheer` | `12 05` | `55 AA 06 12 05 06` |
| 一键起身 | `standUp` | `12 08` | `55 AA 06 12 08 06` |
| 一键收纳 | `standToFall` | `12 09` | `55 AA 06 12 09 06` |
| 移动 | `move` | `13 <vx> <vyaw>` | `55 AA 07 13 <vx> <vyaw> 07` |
| 文字说话 | `speak` | `16 <UTF-8 文本>` | 长度随文本变化 |
| 设置音量 | `volume` | `32 <0…100>` | 例如 75%：`55 AA 06 32 4B 06` |

`Dance` 使用 `DANCE_ID = 0x1E` 加舞蹈编号 `01`，不是只发送进入舞蹈模式的 `KEYSTROKE 0`。

### 5.1 移动字节与当前低速值

`vx` 和 `vyaw` 均为有符号单字节，在线路中按二进制补码表示。当前界面使用低速值 `40 = 0x28`，负值为 `-40 = 0xD8`。

| 操作 | `vx` | `vyaw` | 完整帧 |
| --- | ---: | ---: | --- |
| 前进 | 40 | 0 | `55 AA 07 13 28 00 07` |
| 后退 | -40 | 0 | `55 AA 07 13 D8 00 07` |
| 原地左转 | 0 | 40 | `55 AA 07 13 00 28 07` |
| 原地右转 | 0 | -40 | `55 AA 07 13 00 D8 07` |
| 停止 | 0 | 0 | `55 AA 07 13 00 00 07` |

左右按钮是原地转向，不表示左右平移。官方 BLE 转换会忽略 `vy`，当前没有据此实现侧向平移。

### 5.2 文字说话

文本使用 UTF-8 直接跟在 `0x16` 后。当前限制为 **120 个 UTF-8 字节**，不是 120 个汉字；40 个中文汉字通常已占 120 字节。

“你好”的完整帧：

```text
55 AA 0B 16 E4 BD A0 E5 A5 BD 0B
```

TTS 没有播放完成回执。“说话指令已发送”只表示 BLE 写入完成，不证明机器人已经发声。实际声音还受机器人音量、扬声器输出状态、语音功能和网络/语音服务状态影响。音量滑块是待设置值，不是从机器人读取的当前音量。

## 6. 移动与动作安全状态

官方要求移动前先进入行走或跑步模式。当前实现固定提供低速行走模式：

- 未进入行走模式时，后端拒绝非零移动指令；
- 只有成功写入 `walk` 后，方向键才启用；
- 执行跳舞、挥手、握手、欢呼、起身或收纳后，退出本窗口记录的行走状态；
- 移动中执行其他命令前，后端先发送零速度帧；
- 断开或关闭窗口时，如仍在移动，后端先尝试发送零速度帧。

前端在以下情况发送或排队补发零速度帧：

- 松开方向键；
- 指针取消或失去捕获；
- 键盘方向按钮松开 Space / Enter；
- 窗口失焦或页面隐藏；
- 页面关闭；
- 用户点击“停止”。

如果上一条移动指令仍在传输，松手停止不会被丢弃，而会在当前调用结束后继续发送。移动异常时会尝试一次零速度停止；停止状态无法确认时，界面要求用户断开连接。

## 7. 起身与收纳安全

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

## 8. 权限与窗口边界

- IPC 仅允许标签为 `bumi-control` 的本地窗口；
- 仅接受精确的 `/bumi-control.html`，拒绝查询参数、片段、用户信息和非预期端口；
- 开发来源仅允许调试构建中的 `http://127.0.0.1:1430`；
- 主窗口、宠物窗口和远程网页没有 `bumi_control` 权限；
- 禁止窗口导航到其他页面及打开新窗口；
- 关闭窗口会释放会话所有权并断开设备。

## 9. 验证

在 `apps/aichat-rust` 中执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib app::bumi --features dev-bins
node --test tests/bumi-control.test.cjs
pnpm typecheck
pnpm build
```

协议测试覆盖：

- 所有固定指令帧；
- 正负移动字节和零速度帧；
- 中文 TTS UTF-8 编码及 120 字节边界；
- 电量/状态通知解析；
- 非法帧头、长度和尾部校验；
- 本地页面来源限制。

界面测试覆盖菜单入口、独立 ACL、生产入口、方向键、停止按钮、行走模式、安全确认、说话输入和主题同步。

真实机器人的移动、动作和声音仍需要在平坦、安全的环境中逐项现场验收；单元测试和生产构建不能替代物理动作验证。

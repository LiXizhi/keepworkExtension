# `apps/aichat-rust` 验证与冒烟测试清单

## 2026-11-12：固定分辨率完整缩放显示（0.2.70）

上一轮只验证网页内部尺寸，遗漏较小面板应完整显示固定视口的要求。新增独立可选 `browserSurfaceScaleVersion: 1`，依赖 surface-v1 和 viewport-v1。工具使用 `min(1, 可用宽/视口宽, 可用高/视口高)` 计算显示比例；原生以外层 NSView 的 frame/bounds 坐标变换缩放完整 WKWebView，保留内部 CSS 视口及应用 pageZoom。宿主按相同比例换算裁剪偏移，缺少能力时明确保留旧原尺寸滚动行为，不静默忽略缩放请求。旧 bounds/viewport 请求继续有效；没有 UA、screen 或第三方网页样式改写。

- 本轮修改前原生夹具失败：逻辑 1280×800、显示区域 640×400，实际整页转换到父视图仍为 1280×800，证明仍在裁切。日志 `/private/tmp/keepwork-browser-fit-before.log`。
- 原生专项 **2/2**：1280×800 整页转换后为 640×400，四边均在 visibleRect 内；原生 NSEvent 点击逻辑右下角按钮、聚焦输入并键入成功。2×应用缩放叠加 0.25×适配仍保持 1280×800、显示 640×400，原生点击命中正确。没有用 DOM click 替代缩放输入验收。旧视口、权限隔离、导航及销毁回归继续通过。日志 `/private/tmp/keepwork-browser-fit-native-input.log`。
- 百度实测 **2/2**：innerWidth/clientWidth=1280、innerHeight/clientHeight=800、documentWidth=1280，整页完整可见，搜索输入和提交按钮都位于视口内。原生页快照按已验证的 640×400 显示尺寸导出，截图 `/private/tmp/keepwork-native-baidu-fit.png` 已查看；日志 `/private/tmp/keepwork-browser-fit-baidu.log`。这是隔离原生视图和输入测试，不是用户当前桌面窗口的截图或真人鼠标验收。
- `pnpm --prefix apps/aichat-rust check` 最终通过 TypeScript、前端构建、Rust **118通过/1忽略/0失败**、Node **283通过/4平台跳过/0失败**，包含并行遥控器语音模块的测试。日志 `/private/tmp/keepwork-browser-fit-full-final.log`。`npm run check:shared` 和 `cargo build --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 也通过，日志 `/private/tmp/keepwork-browser-fit-{shared,build}.log`。

网页完整显示、四角截图像素、旧能力兼容及宿主消息回归见 AIChat `tests/README.md`。需要新桌面进程及更新后的网页源码；未发布安装包。

## 2026-11-12：固定视口与原生裁剪分离（0.2.68）

确认原生页面此前直接采用被宿主裁小的可见区域作为 WKWebView 尺寸，导致平板/桌面预设受到窗口、Console 和滚动画布影响。新增可选 `browserSurfaceViewportVersion: 1`：`bounds` 仍表示可见区域，`viewport` 独立给出完整 CSS 尺寸及裁剪偏移。原生裁剪容器限制绘制范围，内层网页保持完整布局尺寸；应用缩放同步 pageZoom，不伪造页面属性或改变网站内容。旧请求省略 viewport 时继续采用历史 bounds 语义；新网页对未声明能力的旧原生宿主禁用固定尺寸，普通浏览不受影响。

- 真实修改前原生回归失败：请求 768×1024、可见 600×400，网页实际得到 `{width:600,height:400}`。证据 `/private/tmp/keepwork-browser-viewport-before.log`；本轮修改前源码保存在临时文件中，不是历史发布版本验收。
- 原生专项 **2/2**：平板 768×1024、手机 390×844、桌面 1280×800 的页面实际 innerWidth/innerHeight 与媒体查询；裁剪/滚动偏移；2×应用缩放；响应式旧请求恢复；页面状态不因改尺寸丢失。原网页隔离、链接/历史和生命周期检查继续通过，日志 `/private/tmp/keepwork-browser-viewport-native.log`。
- `pnpm --prefix apps/aichat-rust check`：最终 TypeScript、前端构建、Rust **101/101**、Node **279通过/4平台跳过/0失败**，包含工作区并行新增模块。日志 `/private/tmp/keepwork-browser-viewport-full-final.log`。`npm run check:shared` 与 `cargo build --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 也通过，日志 `/private/tmp/keepwork-browser-viewport-{shared,build}.log`。
- 实际百度专项 **2/2**：innerWidth=768、innerHeight=1024，宽度媒体查询匹配；站点文档仍宽 1250（其 `#wrapper` CSS 设置 min-width:1250px），因此横向溢出不能视为视口未生效。其水平滚动条占 15px 时 clientHeight/visualViewport.height=1009，高度媒体查询不会等于包括滚动条的 innerHeight。没有改写百度样式、UA 或 screen 属性。日志 `/private/tmp/keepwork-browser-viewport-baidu.log`；截图 `/private/tmp/keepwork-native-baidu-viewport.png` 已查看。

AIChat 宿主、工具、能力降级与画布滚动回归见相邻源码 `tests/README.md`。本轮未发布安装包，需要加载新桌面进程和更新后的网页源码；Windows/Linux/Electron 不宣称支持此原生能力。

## 2026-11-12：小米遥控器 ATVV 与 Keepwork 云端听写（0.2.71）

本轮将遥控器输入改为 Rust 原生内置的蓝牙连接、ATVV 解码和输入控制；松手后把当前一段内存 PCM 发送到 Keepwork 云端 ASR，识别完成再粘贴到系统光标。设置窗口只保留可选设备 ID 和启动/停止，不再要求安装 Python、准备 venv 或下载本地模型。使用入口、联网要求和权限说明见 [README.md](README.md#小米遥控器语音输入)。默认关闭，不自动启动；不依赖网页或 MCP 版本，不向网页暴露音频、转写文字或任意键盘注入接口。

已执行的验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript、前端构建、Rust **120 通过 / 1 实连测试默认忽略**、Node **283 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-native-remote-voice-check.log`。
- `cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins live_keepwork_speech_accepts_synthetic_silence_without_credentials -- --ignored --nocapture`：真实 Keepwork 服务 **1/1 通过**，完成 TLS、`ready`、生成的 0.5 秒静音 PCM 上传、`asr_end` 与 `done`。无凭据、真实麦克风、遥控器录音或剪贴板操作；不等同于真实人声准确率验证。日志 `/private/tmp/keepwork-remote-voice-cloud-live.log`。
- `node --test apps/aichat-rust/tests/remote-voice.test.cjs apps/aichat-rust/tests/remote-voice-native-input.test.cjs`：**5/5**，覆盖私有设置 ACL、无运行时/模型依赖、固定服务协议和 macOS fake AX 窗口/控件/选区检查。
- Windows x64、ARM64：真实 BLE、ATVV、ASR、原生输入模块及其测试的隔离集成 `cargo check --offline --tests --target <target>` 均通过，异步任务经 `tokio::spawn` 检查 `Send`；仅应用宿主状态方法使用 stub。临时夹具 `/private/tmp/keepwork-native-remote-voice-check`。未进行 Windows 可执行文件链接、打包或设备实测。
- `cargo build --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，已生成 macOS arm64 开发程序 `src-tauri/target/debug/Keepwork`，需重启新构建进程。四处版本同步 **0.2.71**，未发布安装包。构建日志 `/private/tmp/keepwork-native-remote-voice-build.log`。

以下为其余验收要求和边界；未将代码检查或夹具验证等同于完整真机链路通过。

- **免环境准备与失败边界**：在未安装 Python、没有本地语音模型的系统中直接启动；无“准备环境/模型”按钮、路径要求、安装脚本或后台下载。覆盖设备 ID 留空/指定、无 BLE 适配器、设备不可达、权限拒绝、重复启动和停止。错误有明确来源，不影响普通聊天或其他原生能力。
- **协议与音频夹具**：验证 ATVV 握手、控制消息、120 字节 ADPCM 帧、高 nibble 优先解码与已知 PCM 向量，覆盖通知分片、重复起止、空录音、超长录音、断连中止及重连。核对 `MIC_OPEN` 时机，避免“约 1.9 秒无声音频”旧问题；输出须为 16 kHz 单声道 signed PCM16 little-endian。
- **Keepwork ASR 契约**：使用固定 `wss://speechrtc.keepwork.com/speech`，`asr_format=pcm`、`asr_rate=16000`；等待 `ready` 后发送当前录音的二进制 PCM，结束发送 `{type:"asr_end"}`，仅在本轮 ASR 完成后使用识别文字。真实本地 WebSocket 夹具覆盖累计快照替换、空最终快照、服务错误、握手/完成超时、连接中断、未知附加字段及缺失可选 TTS 元信息；不发送 TTS 请求。线上验证范围仅为上方合成静音实连。
- **网络与重试**：录音松手前不上传。断网、服务拒绝或超时后显示识别失败，不自动重传音频、不回退本地模型、不输入部分结果。网络恢复后仅新录音可建立新请求；停止、退出和新会话令旧请求失效，迟到结果不得粘贴。
- **输入与生命周期**：仅就绪后预留全局 F5，实体键盘 F5 同样被预留；停止、断连和退出后恢复。记录开始录音时的前台目标，识别完成前切换目标时仅复制文字、不自动粘贴；不按 Enter、不唤起主窗口。停止或退出时取消未完成录音/识别，不延迟粘贴、不重复输入。
- **忙时与固件恢复**：PTT 夹具验证识别忙时丢弃整段新录音，直到松键都不接收尾部、不发 `MIC_CLOSE`、不排队，上一段识别继续。损坏/超时需要 `MIC_CLOSE` 时结束本次连接，释放 F5 并重建 GATT 订阅，避免固件 2671 关闭后 Notify 失效仍显示假就绪；该固件的实际恢复仍需实机验证。
- **权限与兼容**：macOS 覆盖首次蓝牙、辅助功能与输入监控的允许/拒绝/撤销；Windows 覆盖 BLE 不可用、访问被拒绝和更高权限应用拒绝粘贴。分别验证新旧 AIChat 网页、MCP 未运行或旧 MCP、离线网页下的原生入口；网页离线不影响入口，但云端识别仍需网络。普通聊天、网页麦克风、终端和文件操作保持可用。CEF/Linux 不宣称具备该输入能力。
- **隐私边界**：启动前明确提示录音将发送到 Keepwork 云端。确认录音按住期间仅在内存保存、松手后仅发送当前一段，不写入本地录音文件；音频与转写文字不进入 Rust 日志、网页或 MCP。粘贴/目标变化时仅预期文字进入系统剪贴板。

**待真实设备与服务验证**：Windows 与 macOS 分别连接 RC001/RC003，完成按住录音、松手后由真实 Keepwork 服务识别、中文及中英混输，并在 AIChat 输入框和外部编辑器中验证当前光标插入、焦点变化、停止、睡眠/唤醒、断连恢复及网络中断。还需验证实际权限提示归属、F5 恢复和目标应用对粘贴的接受情况。协议与输入夹具通过不等于真实蓝牙到云端 ASR 端到端通过；本记录尚不宣称任一平台的完整真机链路已通过，也不代表已发布安装包。

## 2026-11-12：集成浏览器使用原生网页视图（0.2.67）

确认原集成浏览器对外部网址仍设置 `iframe.src`，且把 iframe 错误文档的 load 事件标为“页面已加载”。新增可选 `browserSurfaceVersion: 1`；macOS 桌面通过独立 WKWebView 在工具画布内浏览外站，不移除网站的 XFO/CSP。网页没有 Tauri 注册、IPC、应用初始化脚本，也不共享 AIChat 的 cookies/localStorage。宿主按工具实例管理不透明 ID、裁剪边界、遮挡、切页、关闭及迟到事件；工作区调试保留原协议。能力缺失的旧端继续可用，外站状态和日志明确显示未知。未改变 MCP 协议或要求客户端/服务端同步升级。

- `pnpm --prefix apps/aichat-rust check`：最终 TypeScript、前端构建、Rust **98/98**、Node **278通过/4平台跳过/0失败**，日志 `/private/tmp/keepwork-browser-surface-full-final.log`。Bridge 行为及原生输出边界定向复验 **2/2**，日志 `/private/tmp/keepwork-browser-surface-native-final.log`。
- `node --test apps/aichat-rust/tests/browser-surface-macos.test.cjs`：真实 WKWebView 覆盖 XFO DENY/CSP frame-ancestors none 页面渲染与原生像素快照、无桌面凭据/脚本、链接/历史、禁止本地协议、隐藏/恢复/关闭及主文档重置。仅监听本轮临时 loopback 服务；测试结束移除视图与临时文件。
- `AICHAT_BROWSER_SURFACE_LIVE=1 node --test apps/aichat-rust/tests/browser-surface-macos.test.cjs`：实际百度标题“百度一下，你就知道”、搜索框和无桌面 Bridge 检查通过。截图 `/private/tmp/keepwork-native-baidu.png` 已查看。当前百度 GET 未返回 XFO，未将它的具体白屏原因声称为已经确认的 XFO 拦截；已确认的是错误的 iframe 浏览路径与假成功状态。
- `npm run check:shared` 通过，日志 `/private/tmp/keepwork-browser-surface-shared.log`。AIChat 工具、宿主、兼容性、安全回归及版本见相邻源码 `tests/README.md`。

此项原生实现仅在 macOS Rust 桌面声明；Windows/Linux/Electron 不宣称已支持或实测。实时百度为隔离原生视图验证，宿主路由使用真实 AIChat 加夹具验证，不等于已在用户运行的桌面窗口中验收。需要新桌面原生进程和更新的 AIChat 源码同时加载；仅刷新旧桌面网页不会更新原生层。未发布安装包或修改现有共享服务。

## 2026-11-12：桌宠分身系统播音与隐藏主窗调度（0.2.64）

主窗口显式使用 `BackgroundThrottlingPolicy::Disabled`。macOS 14+ 的 WebKit 默认后台调度在隐藏窗口停止系统播音后，可能让下一次播音及 JS 回调停住；单变量原生对照复现，并确认禁用节流后恢复。保持主窗隐藏和焦点不变，不改媒体权限、宠物窗口或弹窗；较旧 macOS、Windows/Linux 的支持边界沿用 Tauri，此项不代表这些平台已实测。维持后台通话和终端的页面调度可能增加后台耗能。

相邻 AIChat 分身包 **1.0.26**：系统音色由页面持有浏览器 utterance，明确正常语速和中文音色/语言，兼容忽略 lang/voice 的旧 SDK；无需同步更新 MCP 或 SDK。结束回调前不重启 ASR；启动/播放超时、错误、挂断和旧回调均有边界，不重发分身任务。云端音色沿用原路径。

- `RUST_TEST_THREADS=1 pnpm --prefix apps/aichat-rust check`：TypeScript/前端构建、Rust **88/88**、Node **276通过/4平台跳过/0失败**；日志 `/private/tmp/pet-silent-native-check.log`。
- `npm run check:shared`：通过；日志 `/private/tmp/pet-silent-shared-check.log`。
- 持久原生回归 `scripts/wk-persona-playback.swift`：实际加载 AIChat `persona_voice.js` 与 `desktop_pet_audio.js`，非持久 WKWebView、无麦克风/账号/网络；隐藏主窗完成三轮中文播音、播报中停止和立即新播。最终 **PASS**，旧 promise **1ms** 释放，新播 **2598ms** 完整结束，SDK 调用为零；日志 `/private/tmp/wk-persona-playback-repo-fixed.log`。仅改后台调度为默认策略的对照会在停止后新播超时；增加250ms等待无效，没有在产品里加入等待或自动重播。

复跑原生回归（macOS 14+，源码目录通过环境变量传入）：

```sh
xcrun swiftc -parse-as-library -module-cache-path /tmp/wk-persona-module-cache apps/aichat-rust/scripts/wk-persona-playback.swift -o /tmp/wk-persona-playback -framework Cocoa -framework WebKit
PERSONA_MODULE_SOURCE_ROOT=/path/to/AIChat /tmp/wk-persona-playback
```

设置 `PERSONA_DISABLE_THROTTLING=0` 运行默认调度对照；低于 macOS 14 退出77。该验证证明真实 OS 播音事件和完整持续时间，不代表已做真人耳听或线上版本组合验收。未发布安装包。

## 2026-11-12：宠物分身后台通话与语音播放速率（0.2.63）

新增可选 `petVoiceAudioVersion: 1`，仅网页与宿主双方协商、分身目标且使用云端识别时启用。由可见宠物在一次原生点击签发的文档/context绑定租约内采集，主窗口保持原可见性、最小化状态和焦点。一次通话持续持有采集，每轮 ASR 只在 ready 后订阅 PCM；静音、思考、播报期间 ACK 后丢弃音频，不上传或留到下一轮。挂断（含权限等待中）、隐藏、账号/目标/引擎变化、原生停止或错误释放整个采集；旧端与不支持的目标/引擎保留既有路径。不修改 MCP 或分身消息请求契约。

相邻 SDK 修复在 `keepworksdk` **1.0.9**：使用 `/speech` 的 `ready.tts` 实际格式/采样率播放，保留请求默认值及旧服务缺字段行为，重连清空协商状态。真实历史源码隔离夹具复现 16000 个 16kHz PCM 样本仅播放 0.667 秒，修复后为 1 秒；不调整语速参数。

- AIChat 相关 Node **95/95**；Chrome **11/11**（后台通话、两轮/静音/播报、旧听写与旧端分身语音）。本轮修改前 `persona_voice.js` 注入同一浏览器回归时，因主页面创建采集 AudioContext（1 而非 0）失败。日志 `/private/tmp/pet-call-node-complete-20261112.log`、`/private/tmp/pet-call-browser-{before,fixed}-20261112.log`。
- SDK 新增音频格式/时长回归、原语音协议、缓存测试及类型检查通过；覆盖 16/24/48kHz、48kHz硬件上下文、突发分块顺序、共享 ASR/TTS、重连和有界音频错误。新回归命令 `node test/runSpeechAudioFormatTests.mjs`，根复验日志 `/private/tmp/pet-call-sdk-format-root-20261112.log`。
- `RUST_TEST_THREADS=1 pnpm --prefix apps/aichat-rust check`：TypeScript/前端构建、Rust **88/88**、Node **276通过/4平台跳过/0失败**。日志 `/private/tmp/pet-call-rust-check-serial-20261112.log`。初次默认沙箱阻止20个本机端口夹具；允许loopback后的并发检查有1条既有 dev_server 端口池冲突（87/88），改为串行测试后完整通过，未修改该用例或运行时。
- `npm run check:shared`：通过；日志 `/private/tmp/pet-call-shared-check-20261112.log`。AIChat 源语法、JSON、91包/3配置清单与 diff 检查通过。基础包 **1.0.50**；分身包本切片 **1.0.17**，并行产品修改已继续升至 **1.0.18**。

上述浏览器与音频测试使用隔离宿主/SDK/MCP/合成 PCM，不等同原生隐藏窗口、真人麦克风、线上语音服务或已发布版本配对验证。临时测试服务已关闭。需要新的桌面原生进程及网页/SDK 源码加载后生效；未发布安装包或线上 SDK。

## 2026-11-12：集成浏览器导航保留在预览内（0.2.62）

修复 macOS 的 Wry URL 导航回调无法区分主框架和子框架、把预览网址交给系统浏览器的问题。主 WKWebView 的原生 delegate 代理仅处理真实子框架的普通导航，允许无 URL 凭据的 HTTP(S) 和初始 `about:blank`；主窗口、弹窗、下载及其它事件继续交给原 delegate。CEF 兼容宿主也按真实框架标识允许普通 HTTP(S) 预览。桌面 Bridge、媒体授权、敏感链接外传过滤和浏览器嵌入限制不变，Web/MCP 无协议或同步升级要求。

- `pnpm --prefix apps/aichat-rust check`：TypeScript、前端构建通过，Rust **87/87**，Node **276 通过、4 个平台用例跳过、0 失败**。完整检查需允许测试监听 loopback；默认沙箱禁止监听时的端口夹具失败不能视为代码回归。最终日志 `/private/tmp/keepwork-preview-navigation-check.log`。
- `node --test apps/aichat-rust/tests/navigation-macos.test.cjs`：真实 WKWebView **1/1**。同一隔离夹具先不安装代理，复现跨源 iframe 被原 delegate 拒绝；安装生产代理后，`localhost` 子框架经 302 成功渲染并向父页回传消息，原外链分支调用为零。随后顶层跳转仍被原 delegate 拒绝，加载完成事件转发和拒绝后的重载正常。只使用非持久 WebKit 数据与本地 HTTP 服务，未请求百度、未打开 Chrome。
- `clang++ -std=c++17 apps/aichat-rust/windows/cef-host/navigation_policy_test.cpp -o /private/tmp/keepwork-cef-navigation-test`，再运行该二进制：**通过**。覆盖百度 HTTPS、本地 HTTP、跨域跳转、顶层/登录弹窗限制、URL 凭据和非 HTTP(S) 边界。
- `npm run check:shared`：通过；日志 `/private/tmp/keepwork-preview-navigation-shared.log`。

已同步四处版本至 **0.2.62**。本次修复需要加载新的桌面原生进程，仅刷新网页不能更新已运行的旧桌面壳。未发布安装包；Windows 仅验证 CEF 策略夹具，未进行 Windows 实机测试；Linux WebKitGTK 未加入本轮原生适配。`blob:`/`data:` 预览仍沿用既有拒绝行为。

## 2026-11-12：超长源码按职责拆分（0.2.59）

`lib.rs` 从 3240 行降至 31 行，保留公开模块与 API 重导出；窗口装配、状态、IPC、发送者验证、菜单托盘和平台操作移入 `app/`。`app/pet_audio_host.rs` 独立承担文档绑定的录音 IPC、私有音频投递与采集生命周期，消除主窗口与宠物窗口的循环依赖；11 个实现模块的显式同级依赖检查通过。`runtime.rs` 从 2124 行降至 769 行，保留进程监管，清单验证、归档、更新暂存和测试拆入 `runtime/`。原有公开 API、29 条命令的注册顺序及安全验证保持不变。

仓库维护源码复查后均不超过 2000 行（不计锁文件、文档、构建产物和第三方依赖）。新增架构检查约束本应用 `src/` 与 `src-tauri/src/` 的源码行数；模块职责见 README。

- `pnpm --prefix apps/aichat-rust check`：TypeScript 与前端构建通过，Rust **85/85**，Node **257 通过、4 个平台用例跳过、0 失败**。日志 `/private/tmp/keepwork-refactor-check.log`。
- 录音模块拆分后的首轮完整检查遇到既有代理夹具的 `UnexpectedMessage`；保持夹具和生产代码不变，单项隔离 **1/1** 与完整复跑均通过。保留失败日志 `/private/tmp/keepwork-refactor-check-proxy-failure.log` 和隔离复验日志 `/private/tmp/keepwork-refactor-proxy-test.log`。
- `pnpm --prefix apps/aichat-rust smoke`：五个 Rust 冒烟套件全部通过。日志 `/private/tmp/keepwork-refactor-smoke.log`。
- 本轮 Rust 模块定向 `rustfmt` 检查通过，日志 `/private/tmp/keepwork-refactor-fmt.log`；`npm run check:shared` 通过，日志 `/private/tmp/keepwork-decoupling-shared-check.log`。

已同步四处版本至 0.2.59。本轮为结构重构，未执行原生交互窗口或真实麦克风验收，未发布安装包。

## 2026-11-12：宠物原生右键菜单（0.2.58）

定位到renderer已发出 `menu` 请求，但原生分派缺少该分支，静默返回snapshot。现在为受验证的pet窗口构造真实原生菜单并注册一次选择事件处理：六档大小、跟随AIChat/抱抱龙、固定哈奇换宠链接、打开桌面、隐藏和完全退出确认。选择项只接受固定ID，当前偏好显示勾选，复用持久偏好和现有退出nonce。菜单打开/取消保留草稿及语音状态；隐藏/打开沿用语音清理，退出必须进入确认气泡。

macOS Control点按和右键不会进入左键拖动/展开路径；菜单显示失败捕获为宠物错误和徽标提示，只有再次右键才重试。原生菜单跟踪期间保持交互，结束后按实际光标恢复命中检测，不长期拦截透明桌面区域。本地操作不要求登录、网络、AIChat新页面或MCP更新。

- `node --test apps/aichat-rust/tests/pet-renderer.test.cjs`：**43/43**，包括四个新增右键场景及所有原有点击/拖动/语音回归。实际本轮修改前源码 `/private/tmp/pet-context-menu-before.ts` 对照新增四项有三项失败，复现Control点按拖动、事件传播与未捕获菜单拒绝。日志 `/private/tmp/pet-context-menu-renderer-qa-{before-proof,final}.log`。
- Rust `pet_menu::tests`：**3/3**，覆盖所有本地选项/六档缩放与外观勾选、离线标题、固定ID白名单与退出只请求确认、菜单跟踪状态释放。Tauri本地源码已确认未设置窗口菜单也会分发popup选择事件。
- `pnpm --prefix apps/aichat-rust check`：TypeScript/前端构建、Rust **85/85**、Node **256通过、4个平台用例跳过**；`npm run check:shared`通过。日志 `/private/tmp/pet-context-menu-final-check.log` 和 `/private/tmp/pet-context-menu-shared-check.log`。首轮既有loopback代理健康用例出现一次UnexpectedMessage；单项隔离复验通过后完整复跑。菜单修复未修改该用例或运行时实现。

已同步四处版本至0.2.58。未执行用户桌面的真实鼠标右键、Esc/外点关闭、跨屏子菜单及Windows/Linux实机验收；自动化事件、菜单规格和源码检查不替代这些结论。未发布安装包。

## 2026-11-12：宠物云端听写保持主窗口隐藏（0.2.57）

新增可选 `petDictationAudioVersion: 1`。可见宠物在原生一次性 lease 内采集16kHz单声道PCM，隐藏主页面继续使用原 SDK ASR、设置及草稿。lease 绑定受验证的宠物点击、context 与主文档 UUID；音频仅私有投递给该主文档，不能进入全局事件广播。claim/ready/active 确认、有序分块、累计ACK、16块未确认上限及2秒/10秒watchdog保证失联后停止。停止点击原生撤销lease并直接确认，避免后续toggle重新开始。停止、隐藏、打开主窗口、导航/销毁、账号或目标变化释放采集；迟到权限和旧数据不能重新启动。采集模块还保持跨回调的连续重采样相位。

旧宿主/页面未协商该能力时保留现有行为；仅云端听写启用，不切换用户引擎。通话与课堂录音维持原路径；首次系统麦克风授权仍会正常显示，新路径失败不会弹主窗口。无需更新MCP服务。

- `pnpm --prefix apps/aichat-rust check`：最终源码TypeScript/前端构建通过，Rust **82/82**，Node **252通过、4个现有平台用例跳过**。包含9项lease测试、16项capture测试及39项宠物拖动/renderer回归。日志 `/private/tmp/pet-audio-native-final-check.log`。
- `npm run check:shared`：共享类型、布局及AIChat runtime副本检查通过。日志 `/private/tmp/pet-audio-shared-check.log`。
- AIChat基础包 **1.0.41**、official-personas **1.0.10**：Node定向 **97/97**，Chrome新链路 **8/8**、旧宠物及普通主聊天 **6/6**。真实修改前recognition源码对照因主页面创建AudioContext而失败；修复后主页面麦克风/AudioContext/focus计数均0。浏览器使用隔离host/SDK/PCM夹具，不等同原生隐藏窗口实测。日志和命令见AIChat `tests/README.md`。
- `scripts/wk-pet-capture.swift` 编译通过。真实WKWebView确认 `tauri://localhost/pet.html` 为安全上下文且mediaDevices可用、mainVisible=false。当前系统锁屏且不在console，脚本明确退出 **77/BLOCKED**，没有将可见宠物非零PCM和原生停止清理计为通过。日志 `/private/tmp/pet-audio-wk-packaged.log`。解锁后按README中的独立命令复跑；保留WebKit焦点保护，仅用模拟麦克风，不加载账号或云服务。

只读检查确认当前3001的Keepwork进程映射本轮二进制（inode匹配，并含文档绑定的音频桥接）；前端开发页面使用当前模块。真实用户麦克风、线上ASR、解锁后原生宠物采集和Windows/Linux尚待实机验证。未发布安装包，未改动共享MCP运行方式。

## 2026-11-12：跨屏拖动、原生画布与异步轮次（0.2.56）

定位到三个缺口：macOS 先定位再调整尺寸会保持旧底边，令画布顶边偏移；所谓全局跟踪仍依赖网页 rAF 发起调用，切屏暂停渲染时无法持续移动；旧轮拖动的异步响应和结束请求可能干扰新一轮。画布在调用成功前被记为已同步，还会使一次失败后的重试失效。

新增 `pet_canvas.rs`，macOS 主线程一次 `setFrame:display:` 设置完整逻辑范围，成功后才确认同步；原生 16ms 采样负责超过 4px 阈值后的移动和松手最终采样。新增宿主返回可选 `nativeDragTracking`、`dragId`、`dragMoved`，匹配的新 renderer 使用原生广播，旧宿主保留轮询。原生物理按钮仍按下时拒绝合成 pointerup 的结束请求，前端等待确认后区分拖动和单击。旧轮请求/响应不能结束新轮；静止帧不重复广播，屏幕空隙按最近矩形边界选屏，等距保持当前屏。

- 原生：`node apps/aichat-rust/scripts/pet-canvas-native-smoke.cjs` 在实际内屏 `(0,0,1710,1107)/2×` 与上屏 `(-458,-1080,1920,1080)/1×` 间完成 8 次切换，位置、尺寸、归属屏及缩放均准确匹配，退出 0。隔离空白窗口始终隐藏；不操作用户窗口、鼠标、账号或 MCP。旧顺序 `--baseline` 在第一轮上屏时实际 y 为 `-1053` 而目标为 `-1080`，按预期退出 1。日志 `/private/tmp/pet-canvas-native-{baseline,fixed}.log`。
- Rust 控制器覆盖阈值、松手标记、旧轮所有权、空隙选屏、目标屏保存和失败后重试；renderer 覆盖旧轮迟到结果、合成松手、无 DOM move 的原生拖动、原生结束广播、旧宿主降级及单击/双击行为。真实修改前 renderer 快照通过新增回归注入，旧实现按预期失败。日志 `/private/tmp/pet-cross-monitor-renderer-{baseline,fixed}.log`。
- 完整检查：`pnpm --prefix apps/aichat-rust check` 通过 TypeScript、前端构建、Rust **73/73**、Node **236 通过/4 平台跳过/0 失败**（其中 renderer **39/39**）；`npm run check:shared` 也通过。结果及日志见 `/private/tmp/pet-cross-screen-full-check.log`、`/private/tmp/pet-cross-screen-shared-check.log`。首次完整检查仅一条旧源码正则不接受新增可选参数，更新为允许附加字段后复验通过，未放宽行为回归。另对原生异步释放下的双击补测，修复前实际快照有 1/3 用例漏掉合法双击，修复后通过；迟到确认只提供相邻点击事实，不能修改新轮位置或切换其面板。

本轮未自动执行真人跨屏鼠标拖动；显示器拔除、运行中重排、Windows/Linux 与所有屏幕布局的实机验收尚未覆盖。原生几何与隔离事件测试不能替代这些结论。保持单屏固定画布，不修改聊天、草稿、语音、截图权限、MCP 引擎或所有权规则；未发布安装包。

## 2026-11-12：宠物语音启动与隐藏主页面（0.2.55）

实际 macOS WebKit 日志显示，点击宠物语音后主页面仍为 hidden，AudioContext 已运行，但 AudioCapture 始终为 0。WebKit 的 `getUserMediaRequiresFocus` 分支会在页面可见后才开始麦克风请求，因此只恢复 AudioContext 无法解除这层等待。

原生转发现在先验证原 context/readiness，仅对开始新的听写、通话或课堂录音显示、取消最小化并聚焦主窗口，然后以原请求 ID 转发一次。宠物和草稿保留；停止、静音、重复开始及普通文字操作不抢焦点。显示失败清理 pending 并返回可操作错误，不批准系统权限，也不修改 WebKit 的可见性保护。

- `pnpm --prefix apps/aichat-rust check`：TypeScript 与前端构建通过，Rust **71/71**，Node **218 通过、4 个平台用例跳过**。首次沙箱运行有 20 个本机端口测试被阻止；允许隔离 loopback 测试后完整复跑通过。日志 `/private/tmp/aichat-native-voice-check.log`。
- `npm run check:shared`：共享类型、应用布局及 AIChat runtime 副本检查通过。日志 `/private/tmp/aichat-native-voice-shared-check.log`。
- `scripts/wk-capture-visibility.swift`：真实系统 WKWebView **2/2、退出码 0**。隐藏主窗口时请求 pending 且无 PCM；显示后获取模拟音轨并输出非零 PCM；透明整屏宠物窗口覆盖时主页面仍 visible，采集正常；最终音轨 ended、上下文 closed。使用非持久数据与隔离配置的 WebKit 测试麦克风，保留焦点保护，不访问真实麦克风、账号或云 ASR。日志 `/private/tmp/aichat-wk-capture-visibility.log`。

本机开发监听器已自动重建并重启；只读检查确认当前 `3001` 的 Keepwork 进程映射到包含新窗口处理的二进制，映射 inode 与构建文件相同。它的行为需原生版本生效，单独刷新旧客户端网页不足以加载本修复。真实用户麦克风到线上转写仍待用户录音验证；未发布安装包，未改动运行中的 MCP 引擎。

## 1. 自动化验证套件

1. **TypeScript 类型检查与多页面构建**：
   - `pnpm --dir apps/aichat-rust typecheck`
   - `pnpm --dir apps/aichat-rust build`
2. **Rust 单元测试（覆盖全部 14 个核心模块）**：
   - `cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins`
3. **Rust 端到端冒烟测试二进制（`pnpm --dir apps/aichat-rust smoke`）**：
   - `desktop-smoke`：校验受信任入口、子框架拦截、本地文件夹授权与读写、默认 `MyBrain` 目录、媒体/剪贴板权限记忆、Git 检测、开机自启、桌面身份记录、本地源码 Loopback 服务器、单实例锁、菜单载荷与顶栏注入脚本。
   - `runtime-smoke`：校验 Keepwork MCP 运行时监管、远端更新清单校验、ZIP 下载与 SHA-256 校验、纯 Rust 解压、`runtime.json` 校验、暂存（Staged）与激活（Promote）。
   - `pty-smoke`：校验真实 PTY 终端创建、命令执行、游标增量读取、尺寸调整、中断与关闭。
   - `pet-smoke`：校验桌面宠物状态净化、缩放与边界钳制、完全退出分身确认流程及主屏截图权限 TCP 桥接握手。
   - `updates-smoke`：校验桌面客户端自动更新检查、后台下载、SHA-256 校验、`update-metadata.json` 持久化、离线缓存回退（`stale: true`）与安装包准备。
4. **Node 架构、契约与打包配置测试**：
   - `pnpm --dir apps/aichat-rust test`
5. **仓库级共享边界检查**：
   - `npm run check:shared`

## 2. 发布产物校验项

- **自带 MCP 运行时**：
  - `npm run stage --prefix apps/mcp-runtime -- --platform darwin --arch arm64/x64`（Windows 用 `win32`/`x64`）产出 `apps/mcp-runtime/staging/<platform>-<arch>`。
  - `pnpm bundle:mcp -- --require --target <tauri target>` 校验 product、平台、架构、版本、40 位源码 Commit、node 与入口文件及陈旧状态后复制到 `src-tauri/resources/mcp-runtime/<arch>/`。
  - 安装包内确认 `Contents/Resources/resources/mcp-runtime/arm64/runtime.json` 与 `.../x64/runtime.json`（Windows 为 `<安装目录>/resources/mcp-runtime/x64/runtime.json`）存在。
  - 重新 stage 后必须重新打包；`make:mac` / `make:win:x64` 的 `--require` 会在缺运行时或运行时陈旧时中止发布。
- **macOS Universal**：
  - `hdiutil verify` 校验 DMG 镜像完整性。
  - `defaults read <Keepwork.app>/Contents/Info.plist CFBundleShortVersionString` 核对版本号。
  - `lipo -archs <Keepwork.app>/Contents/MacOS/Keepwork` 确认同时包含 `x86_64` 与 `arm64`。
- **Windows x64 / ARM64**：
  - 核对 `x86_64-pc-windows-msvc` 与 `aarch64-pc-windows-msvc` 目标配置及 NSIS 安装包生成。

## 3. 宠物失焦后点击与透明区域穿透（0.2.20）

**本轮状态**：原生命中 geometry 与前端 renderer 自动化检查已通过，覆盖可见区域上报、透明空隙排除、布局/缩放更新、epoch 变化后重新上报，以及按下/释放手势。相关套件为 Rust 单元测试和 `node --test apps/aichat-rust/tests/pet-renderer.test.cjs`。以下真人原生窗口交互、首次点击激活和混合 DPI 多屏场景仍待验证；自动化通过不代表这些场景已经实测。

执行时使用当前构建，记录系统版本、显示器排列及各屏缩放、宠物缩放。准备另一个可输入文字、可点击按钮的应用；宠物保持可见，聊天输入测试使用已经就绪的会话。

1. **失焦后的首次点击宠物**：切到另一个应用并确认其已获得焦点，再将光标移到宠物上，单击一次。预期这一次点击即可展开面板，不穿透到底层，也不需要先在宠物上移动鼠标或补点一次。收起后重复，并覆盖快速移入后点击。
2. **失焦后的首次点击输入框**：展开面板，输入一段草稿；切到另一个应用，再直接单击宠物输入框并输入文字。预期首次点击即可定位光标、继续编辑，原草稿保留，文字不会进入底层应用。重复检查面板按钮与可见回复泡、退出泡/权限泡中的按钮；确认类测试使用取消操作结束。
3. **透明画布与控件间空隙**：在宠物、面板和回复泡以外的透明区域，以及 `stack` 中两个可见区块之间的空隙，单击底层应用的按钮或输入框。预期底层应用立即收到点击，宠物不响应。收起面板、关闭泡后，检查原控件所在区域已恢复穿透；拖拽释放后也应立即可点击透明区域，无整屏拦截宽限。
4. **悬停不抢焦点**：在底层应用输入框中输入文字，把光标移入宠物、面板或回复泡但不点击，再继续键入。预期焦点仍在底层应用，主窗口不会被唤出或前置。紧凑语音控件另在演示/全屏应用前测试，检查悬停和控件操作不将 AIChat 主窗口切到前台；主动点击聊天输入框时应能正常编辑。
5. **缩放与布局变化**：分别使用 `0.5×`、`1×`、`2×`、`4×`，展开/收起面板，并让回复泡高度变化；将宠物移到屏幕上方和下方，使面板重新布局。预期可见控件的首次点击持续有效，旧位置不残留不可穿透区域，隐藏控件与容器空隙不会挡住底层。隐藏再显示宠物后重复首次点击。
6. **跨屏拖动与混合 DPI（待真人验证）**：在缩放比例不同、包含左侧或上方负坐标布局的两块显示器之间拖动宠物，覆盖缓慢跨界和跨界后立即松手。预期宠物随光标落在正确屏幕，保持单屏画布，无拖影或残留命中区；松手后单击宠物、输入框和透明空隙分别正常。保留现有 4px 点击/拖动阈值，复查单击、双击打开主窗口和右键菜单。

任何失败需记录所在屏幕、缩放、触发前是否失焦，以及首次点击落入宠物还是底层；不可用 geometry 或 renderer 测试结果替代原生窗口复现结论。

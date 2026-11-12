# `apps/aichat-rust` 验证与冒烟测试清单

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

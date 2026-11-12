# KeepWork 第二大脑 (`apps/aichat-rust`)

基于 **Rust + Tauri 2（WRY 原生系统 WebView）** 构建的 **KeepWork 第二大脑（AIChat Desktop）** 跨平台桌面客户端，参考 `grokx` 项目的 Rust + Tauri 2 架构对原 Electron 版 `apps/aichat-desktop` 进行重构。常规版本使用系统 WebView，不携带 Electron。0.2.44 包含 Windows 兼容启动的首版预览实现：WebView2 不可用时按需下载 CEF 宿主，Windows 7 SP1 / 8 使用最后兼容的 CEF 109 分支，现代 Windows 的构建工具选择最新稳定 CEF 并记录版本锁定信息。

CEF 首版以云端聊天与登录窗口为范围，尚未移植桌面 Bridge、托管 MCP、宠物和本地文件 / 终端能力；下文桌面功能描述适用于正常的 Tauri / WebView2 路径。兼容安装包不内置 CEF，首次回退需要下载。**这不是已验证的生产发行版**：Windows 预览工作流尚未运行，Windows / Win7 实机验收与 CDN 发布均未完成。工作流使用临时签名密钥，产物不能直接推广到正式通道。构建、下载、发布预览与能力边界详见 [Windows CEF 兼容方案](docs/windows-cef.md)。

## 核心能力与架构

- **主聊天窗口与平台标题栏**：
  - 加载 `https://keepwork.com/chat`（或本地 Loopback `AIChat.html` 开发源码 / `deployment.json` 离线包）。
  - 在受信任顶层主框架内注入 Closed Shadow DOM `#keepwork-desktop-titlebar`：34px 单行 Web 标题栏，包含居中标题、地址胶囊与刷新按钮；Windows / Linux 同行显示校准居中的 K 图标及「文件 / 编辑 / 视图 / 帮助」菜单标题。Windows 使用无系统装饰的窗口，网页为此标题栏预留 34px 空间；macOS 保留系统应用菜单。
  - Web 下拉菜单由客户端自身在 Closed Shadow DOM 内统一绘制，使用 Rust `menu_payload` 提供的菜单数据，不依赖远端页面绘制；采用紧凑的菜单布局，支持展开后横向悬停切换、键盘导航、Esc 与点击外部关闭。标题栏与菜单同步页面深浅色和皮肤 CSS 变量，地址与刷新按钮保留在顶部原位置。
  - 注入只读冻结的 `window.aichatDesktop`（Bridge v1）契约，对现有 Web 端 `desktop.js`、`keepwork_fs.js`、`desktop_menu.js` 保持 100% 兼容。
- **菜单协议 `aichat.desktop-menu.v1` 与命令路由（对齐 `apps/aichat-desktop`）**：
  - 菜单载荷同时提供桌面版形状 `menu: { id, label, items }` 与冗余兼容字段 `menuId` / `items` / `anchor` / `x` / `y`，菜单项标签与 `CmdOrCtrl` 加速键、`shortcut`（macOS `⌘ ⇧ ⌥`）与桌面版逐项一致。
  - **页面命令**（`new-chat`、`toggle-sidebar`、`toggle-files`、`open-settings`、`experience-simple`、`experience-professional`、`theme-light`、`theme-dark`）只投递给 AIChat 页面；**主机命令**（`open-folder`、`reload`、`check-updates`、`toggle-login`、`quit`、编辑/缩放/全屏/开发者工具、`mcp-status`/`mcp-dashboard`/`mcp-restart`、`open-browser`、`local-source`、`published-site` 等）由桌面进程原生执行，未知 id 一律拒绝。
  - 旧 id（`file:open-folder`、`view:reload`、`view:reset-zoom`、`help:check-updates` …）由 `canonical_host_command` 规范化，客户端 Web 菜单、原生托盘、macOS 系统菜单与历史页面调用方继续可用；页面命令沿用 `aichat.desktop-menu.v1` 投递，主机命令通过白名单校验的 IPC 执行。
- **自我更新与自动更新（Self-Update / Auto-Update）**：
  - **Keepwork MCP Runtime 更新（`:8089`）**：默认随客户端携带 Rust MCP；捆绑清单为 `engine: rust` 时关闭 Node feed 热更新，避免被 Node 运行时覆盖。显式选择 Node 兼容构建时，沿用 `https://cdn.keepwork.com/keepwork/mcp-stable/<platform>-<arch>.json`、大小/SHA-256/40 位源码 Commit 校验、暂存激活与启动失败回滚流程。
  - **桌面客户端自动更新（Desktop Self-Updater）**：启动后 15 秒及每 6 小时检查 `https://cdn.keepwork.com/keepwork/aichat-desktop/<target>/latest-client.json`（或 `AICHAT_UPDATE_FEED_URL`），后台自动下载更新包并校验 SHA-256，持久化 `update-metadata.json`（离线时保留上次检查缓存并标记 `stale: true`）。用户在独立「检查更新」窗口（`updates.html`）点击「更新桌面应用」并确认后退出并启动新版本安装。
- **自带的 Rust Keepwork MCP Server（`apps/mcp-rust`）**：
  - `aichat-rust` 默认运行 `apps/mcp-rust`，由 `scripts/bundle-mcp-rust.cjs` 构建原生守护进程并写入 `src-tauri/resources/mcp-runtime/<arch>/{runtime.json,bin/keepwork-mcp}`（Windows 为 `.exe`）。清单 v2 使用 `product: keepwork-mcp-runtime` 与 `engine: rust`；宿主直接执行原生入口。
  - 标准开发与 `make:mac` / `make:win:x64` / `make:win:arm64` 打包入口选择 Rust MCP；`bundle:mcp` 默认捆绑 Rust，`bundle:mcp-rust` 保留为同义入口。`apps/mcp-runtime` 的 Node 版通过 `bundle:mcp-node`、`make:mcp-node:mac` 和 `make:mcp-node:win:x64` 显式选择，仍须先准备并校验对应 Node staging。Rust 构建或校验失败时明确报错，不因缺少可选能力自动改用 Node。
  - Rust 已提供本地文件、文件夹浏览、PTY、五个可移植 MCP 工具，以及分身和钉钉/飞书消息的部分能力。原生 Agent CLI、浏览器、电脑操作等仍未全面移植；按 `/health` 的实际能力降级，不能凭引擎或版本号推断支持。详见 [迁移契约](../../docs/rust-runtime-migration.md)。
  - 既有共享 8089 服务继续按所有权和接管规则处理；默认候选为 Rust 不代表已有外部服务已被替换，实际引擎须检查 `/health.runtimeEngine` 与进程入口。
- **双本地 Runtime 守护进程监管**：
  - 监管 MCP（`127.0.0.1:8089`，默认 Rust）与 `keepwork-local-model-node-runtime`（`127.0.0.1:18089`），60 秒心跳巡检。MCP 引擎选择不改变外部 VS Code / Local Helper 实例的所有权保护，也不放宽 Origin、鉴权、路径和任务执行边界。
- **透明置顶桌面宠物窗口（`pet.html`）**：
  - 跨屏拖动使用原生光标跟踪；切屏时网页暂停动画也能继续移动。macOS 在一次主线程调用中设置目标屏幕的画布位置与尺寸，避免不同屏幕高度导致偏移。超过 4px 才开始拖动，松手提交最终位置；旧轮响应不会移动或结束新一轮。旧宿主缺少原生跟踪标记时仍使用兼容轮询。
  - 右键或 macOS Control 点按宠物显示原生菜单：六档大小（0.5×–4×）、跟随 AIChat/抱抱龙外观、哈奇换宠入口、打开桌面、隐藏宠物和「完全退出…」。菜单不依赖登录或网络；缩放与外观持久保存，完全退出仍需确认气泡授权。打开或取消菜单保留当前草稿和语音状态，不触发左键展开或拖动；菜单显示失败在宠物中提示，可再次右键重试。
  - 宠物云端听写支持可选 `petDictationAudioVersion: 1`：可见宠物采集 16kHz 单声道 PCM，隐藏主页面保留 SDK 识别、配置和草稿，开始听写不弹出主窗口。一次采集绑定原生点击、账号/目标 context 和主页面文档，音频仅在内存中按序传递并确认；停止、隐藏、打开主窗口、导航或账号/目标变化立即释放。权限失败和拥塞在宠物显示错误，首次系统麦克风授权仍正常出现。旧页面、未声明能力的宿主及其他引擎保持原采集方式；macOS 通话、课堂录音或旧路径仍需显示主窗口以满足 WebKit 可见性要求。
  - 固定工作区画布尺寸（`DESKTOP-PET-CLICK-STABILITY-001`），支持 `0.5×`–`4×` 缩放、抱抱龙/跟随 AIChat 宠物外观、快捷回复、语音听写/通话、完全退出分身/通道确认气泡（`#exit-bubble`）以及主屏截图权限审批气泡（`#permission-bubble`，连接 `~/.keepwork-mcp/pet-permission-bridge.json`，点击后先隐藏窗口再返回授权结果以确保气泡不入镜）。
- **本地文件夹授权、工作区文件读写与直连 PTY 终端**：
  - `src-tauri/src/files.rs`：管理 `folder-grants.json`、路径边界校验、软链接/目录联接安全规则与文件大小上限（PPT/PPTX 500 MiB、PDF 100 MiB、通用 1024 MiB）。
  - `src-tauri/src/brain_folder.rs`：管理 `<Documents>/MyBrain` 默认第二大脑文件夹预览与初始化授权。
  - `src-tauri/src/terminal.rs`：基于原生 PTY（Unix `libc::openpty` / Windows Shell）提供 `desktop:<id>` 会话、游标增量输出、窗口尺寸同步与中断控制。

### Rust 源码模块

`src-tauri/src/lib.rs` 仅声明公共领域模块并重导出桌面入口、状态类型与窗口操作，保留原有 crate 根路径的公开 API。Tauri 应用装配集中在私有 `app/` 模块，业务领域模块不依赖窗口装配层。

以下路径均相对 `src-tauri/src/`：

| 模块 | 职责 |
| --- | --- |
| `app/state.rs` | 应用共享状态、配置目录与桌面状态快照 |
| `app/startup.rs` | 运行时资源发现、应用启动、窗口创建与命令注册 |
| `app/sender.rs` | 主窗口、宠物和更新窗口的 IPC 发送者验证 |
| `app/events.rs` | 主页面事件分发 |
| `app/commands.rs` | 文件、终端、菜单、标题栏与主题 IPC |
| `app/main_window.rs` | 主文档生命周期、连接恢复、本地源码切换与缩放 |
| `app/host_menu.rs` | 原生命令执行、系统菜单、托盘与退出流程 |
| `app/pet_host.rs` | 宠物窗口、原生拖动跟踪、菜单操作与页面命令编排 |
| `app/pet_audio_host.rs` | 文档绑定的录音 IPC、私有音频投递、采集停止与超时监控 |
| `app/platform.rs` | 系统浏览器、文件管理器与平台调用 |
| `app/updates_window.rs` | 更新窗口、更新 IPC 与状态通知 |
| `runtime.rs` | 运行时进程监管、所有权、重试、激活和回退；重导出原有运行时 API |
| `runtime/manifest.rs` | 清单类型、平台名称、版本比较与兼容性验证 |
| `runtime/archive.rs` | 受限路径 ZIP 解压、归档生成与摘要 |
| `runtime/staged_update.rs` | 下载、完整性校验与更新暂存 |
| `runtime/tests.rs` | 运行时单元测试与隔离回归测试 |

`app/` 内实现模块沿单向依赖组织；主窗口和宠物窗口共用独立的录音宿主，避免相互依赖。`tests/architecture-and-packaging.test.cjs` 随 `pnpm check` 检查 `src/` 与 `src-tauri/src/` 中维护的源码，每个文件不得超过 2000 行；增长时按职责继续拆分，生成文件和依赖不计入。

### 断网与页面连接恢复

正常的 Tauri / WebView2 路径启动时先显示客户端自带的本地连接页，再由原生宿主使用同一 WebView 导航到原先配置的聊天入口。每次尝试最多等待 20 秒；如果页面未在期限内满足下述就绪条件，会返回本地提示页，分别显示页面连接失败原因和本机 MCP 服务状态。导航调用立即失败时也会返回提示页；等待期间 WebView 仍可能暂时显示系统错误文档或空白，当前流程不保证始终显示本地连接页。提示页只显示入口的 origin，不显示查询参数或片段。

在提示页点击「立即重试」、按 `CmdOrCtrl+R` 或使用菜单「重新加载」，都会重试原入口。失败后依次等待 5、15、30 秒自动重试，最多 3 次；提示页收到 `online` 事件时可提前触发下一次自动重试，并计入同一次数上限。达到上限后保留手动重试，手动重试会重新开始自动重试计数。重复触发不会并行加载，旧尝试的超时不会覆盖已成功打开的页面。恢复流程不会自动切换线上与本地源码入口，也不会更换本地服务端口。

已经正常打开的聊天页不会因断网或恢复联网被桌面端自动刷新；恢复流程不会重发聊天消息或其他操作。云端模型、登录、同步和远端资源仍需要网络。本机已有的 MCP、文件及终端能力独立于外网连接，但页面打不开时，其网页操作入口也可能不可用；本地网页入口需要事先准备和配置。

就绪检测先等待主文档 `DOMContentLoaded`。对已知 AIChat 入口（`https://keepwork.com/chat` 或本地 Loopback 的 `AIChat.html`），如果此时存在空的 `#app`，还会在同一 20 秒期限内等待其出现首个子元素或非空文本，覆盖 HTML 已缓存但 SDK 等脚本未加载导致空白的情况。其他自定义入口或没有 `#app` 的旧页面沿用主文档就绪规则。检测不等待登录、MCP、模型服务或全部子资源，也不要求网页升级 Bridge v1；出现首屏内容后便停止检测。这个基础检测不验证首屏内每个功能是否可用，也不代表支持完整离线聊天。

## 开发与验证命令

### 日常启动与运行时选择

在 `apps/aichat-rust` 目录执行 `pnpm tauri dev` 启动桌面；默认构建并使用 **`apps/mcp-rust`**。VS Code 任务 `keepwork Rust Desktop: Start` 使用同一入口，`pnpm dev:rust` 保留为显式 Rust 别名。`pnpm dev` 只启动桌面页面的 Vite 服务，不启动桌面或 MCP。

默认入口需要 Rust/Cargo 工具链及桌面开发依赖；准备 Rust MCP 失败会停止启动并保留错误。Node.js 仍用于桌面开发工具和可选外部 CLI，并不表示 MCP 服务端使用 Node。`pnpm build` 只构建桌面前端，不会准备或覆盖 MCP 资源；运行时由开发启动器或 `make:*` / `bundle:mcp*` 命令准备。

需要 Node MCP 兼容能力时显式执行 `pnpm dev:node`，或设置 `AICHAT_MCP_ENGINE=node`。该路线要求 Node.js 22 或更新版本，以及仓库、`apps/mcp-runtime` 与桌面的已安装依赖；从当前源码生成独立的 Node 开发运行时，不依赖之前的 staging，也不自动安装或下载依赖。

如显式设置 `AICHAT_MCP_BUNDLED_DIR`（优先）或 `AICHAT_MCP_RUNTIME_DIR`，启动器会校验指定运行时与所选引擎一致；默认 Rust 入口不能借此静默加载 Node。目录设置只在下一次启动读取，不会动态切换运行中的 MCP。Rust MCP 当前尚未提供原生 CLI 会话接口；需要该能力时由用户显式选择 Node，不能自动切换执行语义。

开发页面固定使用 `http://127.0.0.1:1430`。重复启动会先检查开发服务的身份协议和真实项目目录，只复用同一 checkout 的服务。另一个项目、没有身份端点的旧 Vite 服务、无法确认身份的监听者会产生明确的端口占用错误；请在拥有该服务的终端中处理后重试。启动器不结束未知进程，也不自动换端口。关闭复用者不会关闭先前终端拥有的 Vite 服务；关闭原服务的终端后，需要重新启动开发服务。

AIChat 本地源码服务通过 `AICHAT_DESKTOP_LOCAL_SOURCE=1` 或「使用本地源码服务器…」启用，仅监听 `127.0.0.1`。首次从 `3001–3100` 中分配未占用、未保留的端口，将规范化源码目录与入口文件的绑定保存到应用配置目录的 `source-ports.json`。同一目录与入口在重复选择和重启后使用固定 origin，不同目录或入口保留独立端口。已绑定端口被占用、映射损坏或保存失败时明确报错，不自动换端口或接管其他服务。菜单切换源码时，候选服务器准备失败会保留当前页面与服务器；显式设置 `AICHAT_DESKTOP_LOCAL_SOURCE=1` 后启动失败，会记录错误、打开已有的备用入口，并显示一次原生错误提示，说明页面地址不同、原本地记录未搬迁以及重试方法。`deployment.json` 无法打开时保持既有的错误日志与 fallback 行为；其回退诊断只显示该入口的 origin，不包含其 URL 路径、查询参数或片段。

固定 origin 为同一浏览器配置下的本地会话选择、工具页和偏好提供稳定的存储边界。当前自动化验证覆盖地址复用与失败处理；浏览器存储及登录状态在真实桌面重启后的恢复仍需单独验收。旧版本随机端口下的本地数据不会自动搬迁；网页与桌面之间沿用现有云同步规则，当前会话选择和已打开工具页仍只保存在各自本地。

修改启动配置不会停止当前运行的服务；新选择在下次桌面进程启动时生效。默认运行时选择决定本次桌面启动使用的候选，不能证明已存在的共享 MCP 已切换。外部 VS Code / Local Helper 的服务仍受所有权与接管规则保护；验收必须检查实际 `127.0.0.1:8089/health` 的引擎与目标能力，不能仅检查打包目录。需要切换已有服务时，先确认所有者和活跃任务，再按实际启动方式受控重启；不能自动重放未确认结果的任务。

### Windows 签名与交互安装

Windows 发布工作流支持仓库 Secrets `WINDOWS_CERT_PFX_BASE64`（含代码签名私钥的 PFX，Base64 编码）和 `WINDOWS_CERT_PASSWORD`。配置后先对 Rust MCP 签名，再生成资源清单；Tauri 对桌面程序和 NSIS 安装包签名，最后验证安装包及解包后的程序签名和证书指纹。未配置证书时工作流明确告警，生成的仍是未签名测试包。证书须支持 CI 签名；依赖硬件或云签名服务的证书需要对应签名提供程序。

安装器通过本版本程序的 `--stop-mcp <安装目录>` 模式停止该目录内的 MCP：原生 Windows API 核对可执行文件路径、保留同一进程句柄并等待退出，失败则中止安装，不按进程名全局结束服务，也不运行 PowerShell 脚本。新安装的登录自启动默认关闭，已有开关偏好保留。用户确认桌面更新后，通过 Windows Shell 打开可见安装向导，不传静默安装参数；更新包须位于下载目录且通过已有 SHA-256 校验。MCP ZIP 更新在 Rust 内解压，支持 Zip64 和 data descriptor。

这些措施不能保证杀毒软件不误报。确有误报时应保留告警名称、被隔离文件路径和 SHA-256，向对应厂商提交样本复核；提交样本会向厂商上传二进制，应由发布负责人执行。现有 GrokX 的历史检测不能证明 Keepwork 的具体触发原因。

```bash
# 类型检查与前端构建
pnpm typecheck
pnpm build

# Rust 单元测试与 5 个冒烟测试二进制
cargo test --manifest-path src-tauri/Cargo.toml --features dev-bins
pnpm smoke

# 完整检查（TypeScript + Vite + Cargo Test + Node 契约测试）
pnpm check

# 自带 Rust MCP 运行时（从仓库根目录执行）
node apps/aichat-rust/scripts/bundle-mcp-rust.cjs --target universal-apple-darwin
```

### macOS 原生语音采集回归

宠物独立采集与打包页面检查（隐藏主窗口，WebKit 模拟麦克风）：

```bash
xcrun swiftc -parse-as-library -module-cache-path /private/tmp/wk-pet-module-cache apps/aichat-rust/scripts/wk-pet-capture.swift -o /private/tmp/wk-pet-capture -framework Cocoa -framework WebKit
/private/tmp/wk-pet-capture
```

脚本不加载账号、不连接云识别、不读取真实麦克风，保留 WebKit 焦点保护。检查 `tauri://localhost` 安全上下文、主窗口持续隐藏、可见宠物产生非零16kHz PCM，以及停止后音轨/context释放且不再输出PCM。锁屏或非console会话明确退出77并显示 `BLOCKED`；本轮环境处于该状态，只确认了安全上下文与mediaDevices，尚未完成原生可见采集实测。

macOS 原生采集可见性回归可单独运行，需 Xcode 命令行工具与桌面会话：

```bash
xcrun swiftc -parse-as-library -module-cache-path /private/tmp/aichat-wk-module-cache apps/aichat-rust/scripts/wk-capture-visibility.swift -o /private/tmp/aichat-wk-capture-visibility -framework Cocoa -framework WebKit
/private/tmp/aichat-wk-capture-visibility
```

该隔离测试使用非持久 WKWebView 与 WebKit 生成的模拟麦克风，不加载 AIChat 账号、不连接云识别，也不读取真实麦克风。测试专用私有 API 仅启用模拟设备，保留 `getUserMediaRequiresFocus=true`。它验证隐藏主窗口时请求保持等待，按原生取消最小化、显示、聚焦顺序恢复窗口后取得流与非零 PCM，并检查整屏透明置顶宠物画布不会遮蔽主页面的可见性；结束时音轨为 `ended`、AudioContext 为 `closed`，输出 `PASS` 后退出。它不代表真实设备、系统权限或线上 ASR 验收。

### 原生多屏窗口几何回归

从仓库根目录执行 `node apps/aichat-rust/scripts/pet-canvas-native-smoke.cjs`。测试创建隔离、隐藏的空白 Tauri 窗口，在当前连接屏幕间往返，直接检查原生位置、尺寸、屏幕归属和缩放；不启动 MCP、不打开用户页面、不移动鼠标。少于两块屏幕时以退出码 77 明确跳过。`--baseline` 使用旧的先定位、后改尺寸顺序作对照，可能按预期失败。

本轮在 2× 内屏与 1× 上方副屏的 8 次切换通过，旧路径会产生 27px 偏移。这是原生窗口几何验证；连续真人拖动、显示器拔除/重排和其他系统仍需分别验收。

## 多平台打包矩阵

| 平台 | Rust Target | 构建命令 | 产物 |
| --- | --- | --- | --- |
| **macOS Universal**（Apple Silicon + Intel 单包） | `universal-apple-darwin` | `pnpm make:mac` | `Keepwork.app`、`Keepwork_<版本>_universal.dmg` |
| **Windows x64** | `x86_64-pc-windows-msvc` | `pnpm make:win:x64` | `Keepwork_<版本>_x64-setup.exe` |
| **Windows ARM64** | `aarch64-pc-windows-msvc` | `pnpm make:win:arm64` | `Keepwork_<版本>_arm64-setup.exe` |

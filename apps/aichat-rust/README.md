# KeepWork 第二大脑 (`apps/aichat-rust`)

基于 **Rust + Tauri 2（WRY 原生系统 WebView）** 构建的 **KeepWork 第二大脑（AIChat Desktop）** 跨平台桌面客户端，参考 `grokx` 项目的 Rust + Tauri 2 架构对原 Electron 版 `apps/aichat-desktop` 进行重构。常规版本使用系统 WebView，不携带 Electron。0.2.44 包含 Windows 兼容启动的首版预览实现：WebView2 不可用时按需下载 CEF 宿主，Windows 7 SP1 / 8 使用最后兼容的 CEF 109 分支，现代 Windows 的构建工具选择最新稳定 CEF 并记录版本锁定信息。

CEF 首版以云端聊天与登录窗口为范围，尚未移植桌面 Bridge、托管 MCP、宠物和本地文件 / 终端能力；下文桌面功能描述适用于正常的 Tauri / WebView2 路径。兼容安装包不内置 CEF，首次回退需要下载。**这不是已验证的生产发行版**：Windows 预览工作流尚未运行，Windows / Win7 实机验收与 CDN 发布均未完成。工作流使用临时签名密钥，产物不能直接推广到正式通道。构建、下载、发布预览与能力边界详见 [Windows CEF 兼容方案](docs/windows-cef.md)。

**当前范围与验证状态**统一维护在 [Rust 产品能力矩阵](../../docs/rust-capability-matrix.md)。历史 `VALIDATION.md` 记录不代表当前安装包已通过所有平台和真实账号验证；发布前按 [Rust 发布包验收](../../docs/acceptance/rust-desktop-release.md) 生成持久结构化证据。

## 核心能力与架构

- **主聊天窗口与平台标题栏**：
  - 开启托盘中的「显示桌面宠物」后，最小化或关闭主窗口均会显示宠物。从宠物重新打开聊天会回到原来的会话。macOS 上点击程序坞中的应用图标也会恢复并聚焦原聊天窗口，桌宠临时隐藏后同样有效。关闭该选项时，最小化沿用系统行为。
  - 加载 `https://keepwork.com/chat`（或本地 Loopback `AIChat.html` 开发源码 / `deployment.json` 离线包）。
  - 启动与工作台共用同一个主窗口：初始化时保持隐藏，等可信首屏及关键样式准备好后一次显示，保留窗口位置、尺寸和最大化状态。连接失败在同一窗口提供「重试」和「稍后」，恢复界面沿用上次聊天页的亮暗模式，无记录时默认亮色；重试期间再次隐藏。后台启动保持隐藏，关闭后不会因迟到的就绪事件重新弹出；再次打开复用原有页面。
  - 进入受信任聊天入口后，在 SDK 等网络资源完成前预先应用该网页 origin 的主题：有效 URL `theme` 优先，手动模式读取该 origin 保存的亮暗选择，自动模式按本地时间 07:00 起至 19:00 前使用亮色、其余时段使用暗色。桌面对旧聊天页也提供此兼容处理，无需同步发布网页；预主题只读取网页偏好，后续网页主题与皮肤照常接管。
  - 在受信任顶层主框架内注入 Closed Shadow DOM `#keepwork-desktop-titlebar`：34px 单行 Web 标题栏，包含居中标题、地址胶囊与刷新按钮；Windows / Linux 同行显示校准居中的 K 图标及「文件 / 编辑 / 视图 / 帮助」菜单标题。Windows 使用无系统装饰的窗口，网页为此标题栏预留 34px 空间；macOS 保留系统应用菜单。
  - Web 下拉菜单由客户端自身在 Closed Shadow DOM 内统一绘制，使用 Rust `menu_payload` 提供的菜单数据，不依赖远端页面绘制；采用紧凑的菜单布局，支持展开后横向悬停切换、键盘导航、Esc 与点击外部关闭。标题栏与菜单同步页面深浅色和皮肤 CSS 变量，地址与刷新按钮保留在顶部原位置。
  - 标题栏、地址胶囊和菜单跟随页面实际配色，兼容 AIChat 默认深色、主题切换及稍后加载的皮肤样式；本地连接页与聊天页共用主题同步逻辑，解析页面中的 CSS 变量和混合颜色后应用到标题栏。亮暗模式按客户端配置档分别记忆在 `desktop-theme.json`，仅供本地启动与恢复页使用；此记忆独立于各网页 origin 的主题存储，不修改或覆盖网页偏好。聊天页加载后以其实测主题为准，本地启动与恢复页只读取记忆。
  - 注入只读冻结的 `window.aichatDesktop`（Bridge v1）契约，保留现有 Web 端 `desktop.js`、`keepwork_fs.js`、`desktop_menu.js` 的共享合同；新增能力单独协商，缺少可选能力不会要求网页、桌面或 MCP 同步升级。
  - macOS / Windows 正常 Tauri 路径通过可选 `browserSurfaceVersion: 1` 在工具画布内显示独立的原生网页视图（WKWebView / WebView2），支持 HTTP(S)、前进/后退和刷新。外站使用独立的临时网站数据，不注入桌面 Bridge、IPC 或 AIChat 凭据；切页、遮挡及关闭时隐藏或销毁视图。工作区 HTML 保留原有 iframe 预览调试。旧网页、没有此能力的桌面及 CEF 兼容宿主沿用 iframe；新版网页明确提示无法确认外站嵌入结果并提供外部打开入口，不把 iframe 错误文档误报为加载成功。主窗口外链和登录弹窗策略不变。Windows 原生绘制和交互尚待实机验收，范围见 [VALIDATION.md](VALIDATION.md)。
  - Windows 本轮仅声明基础 `browserSurfaceVersion: 1`，采用自适应画布尺寸；不声明 `browserSurfaceViewportVersion` 或 `browserSurfaceScaleVersion`。网页根据缺少的能力禁用固定视口预设，直接要求 `viewport` / 缩放语义的请求明确失败，不静默忽略。每个原生视图使用独立随机 profile 和 WebView2 InPrivate 模式，关闭 host objects / web message，拒绝原生权限请求与下载；旧 WebView2 不支持私密 profile 时返回该浏览器功能的错误，不回退到共享主页面 profile。CEF 兼容宿主不因此获得桌面 Bridge 或原生浏览器能力。
  - macOS 的 `browserSurfaceViewportVersion: 1` 保留固定 CSS 视口，`browserSurfaceScaleVersion: 1` 使完整视口等比缩小到可用画布。1280×800 页面在较小面板中四边完整可见，内部布局尺寸不变；调整窗口或 Console 不重载网页。原生坐标变换同步绘制及点击位置，不以改网页缩放或伪造页面属性代替。仅支持旧 viewport-v1 的宿主明确按原尺寸滚动，缺少该能力时保持自适应并禁用固定预设。此选项不模拟平板 UA、触屏或物理屏幕；网站自身超出所选视口的内容仍由网页滚动。
  - 会话「+ → 打开浏览器」入口属于独立发布的 AIChat 网页；其源码中的入口不按操作系统隐藏，也不依赖原生浏览器能力。有入口的网页配对旧桌面可继续使用 iframe；只安装新桌面不会把入口添加到仍运行旧菜单代码的线上网页。本轮尚未发布 AIChat 网页或桌面安装包。
- **菜单协议 `aichat.desktop-menu.v1` 与命令路由（对齐 `apps/aichat-desktop`）**：
  - 菜单载荷同时提供桌面版形状 `menu: { id, label, items }` 与冗余兼容字段 `menuId` / `items` / `anchor` / `x` / `y`，菜单项标签与 `CmdOrCtrl` 加速键、`shortcut`（macOS `⌘ ⇧ ⌥`）与桌面版逐项一致。
  - **页面命令**（`new-chat`、`toggle-sidebar`、`toggle-files`、`open-settings`、`experience-simple`、`experience-professional`、`theme-light`、`theme-dark`）只投递给 AIChat 页面；**主机命令**（`open-folder`、`reload`、`check-updates`、`toggle-login`、`quit`、编辑/缩放/全屏/开发者工具、`mcp-status`/`mcp-dashboard`/`mcp-restart`、`open-browser`、`local-source`、`published-site` 等）由桌面进程原生执行，未知 id 一律拒绝。
  - 旧 id（`file:open-folder`、`view:reload`、`view:reset-zoom`、`help:check-updates` …）由 `canonical_host_command` 规范化，客户端 Web 菜单、原生托盘、macOS 系统菜单与历史页面调用方继续可用；页面命令沿用 `aichat.desktop-menu.v1` 投递，主机命令通过白名单校验的 IPC 执行。
- **自我更新与自动更新（Self-Update / Auto-Update）**：
  - 版本号、字段语义、七牛 CDN 路径与发布顺序统一见 [CDN 版本与更新清单规范](../../docs/update-manifests.md)。
  - **Keepwork MCP Runtime 更新（`:8089`）**：默认随客户端携带 Rust MCP，使用独立 `https://cdn.keepwork.com/keepwork/mcp-stable-rs/<platform>-<arch>.json` v2 feed；显式 Node 兼容构建沿用 `mcp-stable/<platform>-<arch>.json` v1。两条线路分别校验引擎/产品/目标、大小/SHA-256/40位源码commit及包内身份；Rust额外核对嵌入binary编译身份。下载只暂存，不打断正在运行的服务；用户点击「更新 MCP」可显式激活，下一次宿主启动且需要启动本地服务时，也可采用同引擎、严格新于已验证current/bundled基线的pending，保留原Node启动行为。同版本不同commit的候选只能显式应用，不随普通启动替换。激活前核对实际服务PID/owner，新候选健康和身份确认后才提升current；失败回退已验证可用版本并保留用户数据。缺少运行中peer版本、commit或引擎字段时显示未知，不借本地捆绑版本填充。不通过Node feed覆盖Rust，也不自动重发未知任务。源码与本地清单验证不表示Rust CDN已发布或真实安装升级已验收。
  - **桌面客户端自动更新（Desktop Self-Updater）**：启动后 15 秒及每 6 小时检查 Rust 专用 `https://cdn.keepwork.com/keepwork/aichat-rust/<target>/latest-client.json`（或 `AICHAT_UPDATE_FEED_URL`），与 MCP 独立并行检查。仅有 `win32-x64`（EXE）、`win32-arm64`（EXE）、`darwin-universal`（DMG）三个目标；Intel 与 Apple Silicon Mac 使用同一 Universal 清单。后台下载并校验大小与 SHA-256，持久化 `update-metadata.json`，下载就绪后通知；离线保留同一 feed URL 的上次检查缓存并标记 `stale: true`。切换地址或旧缓存没有来源时，不恢复旧渠道的可安装候选；新地址缺失时明确报告检查失败，不自动回退到 Electron / Launcher 渠道。已校验的更新会在用户选择「完全退出」时自动覆盖安装，安装完成后保持退出；关闭主窗口进入桌面宠物不触发安装。也可在独立「检查更新」窗口（`updates.html`）点击「重启并更新」，确认后自动替换并重新打开应用，无需操作安装向导或拖动 DMG 中的应用。下载完成本身不会打断聊天、终端或通话。
  - **覆盖安装边界**：Windows 使用当前用户 NSIS 安装包更新当前安装目录；macOS 从已校验 DMG 准备新应用，再替换当前可写的已安装 `.app`。从只读磁盘映像、系统 App Translocation 或开发目录运行时不自动覆盖，请先安装到可写位置。覆盖只处理应用程序文件，保留用户配置、聊天数据和工作区；MCP 独立更新入口及外部宿主所有权检查保持有效。准备或替换失败会报告错误并保留可恢复内容，不把安装器启动当作升级成功；下一次实际启动的新程序版本才是已安装版本。应用替换失败恢复不等同于新版本启动后的完整健康回滚。
  - **发布与旧客户端兼容**：Rust 发布器在三个版本化安装包全部通过 CDN 字节校验后，仅更新 Rust 专用的三个清单，不改写历史 `aichat-desktop` 四个清单。新清单沿用 `schemaVersion: 1` / `product: aichat-desktop` 字段合同，macOS 使用 `arch: universal`；顶层原生包描述与 `installer` 指向同一包，客户端优先读取 `installer.version`。禁止清单版本倒退或同版本替换安装包。**旧 Rust 客户端仍读取旧地址，需要手动安装使用 Rust 专用地址的新版，或显式配置受支持的 feed 地址，才能迁入新渠道；新发布器不自动迁移旧指针。** 已安装 CEF / 外层 Launcher 继续使用独立签名渠道。清单发布与实际安装升级须分别验收，源码修改不代表三个新地址已在线上发布。
- **自带的 Rust Keepwork MCP Server（`apps/mcp-rust`）**：
  - `aichat-rust` 默认运行 `apps/mcp-rust`，由 `scripts/bundle-mcp-rust.cjs` 构建原生守护进程并写入 `src-tauri/resources/mcp-runtime/<arch>/{runtime.json,bin/keepwork-mcp}`（Windows 为 `.exe`）。清单 v2 使用 `product: keepwork-mcp-runtime` 与 `engine: rust`；宿主直接执行原生入口。
  - 标准开发与 `make:mac` / `make:win:x64` / `make:win:arm64` 打包入口选择 Rust MCP；`bundle:mcp` 默认捆绑 Rust，`bundle:mcp-rust` 保留为同义入口。`apps/mcp-runtime` 的 Node 版通过 `bundle:mcp-node`、`make:mcp-node:mac` 和 `make:mcp-node:win:x64` 显式选择，仍须先准备并校验对应 Node staging。Rust 构建或校验失败时明确报错，不因缺少可选能力自动改用 Node。
  - Rust 已提供本地文件、文件夹浏览、PTY、五个可移植 MCP 工具、Dashboard/管理目录、原生 Agent CLI 会话与图片轮次、分身本地工具、钉钉/飞书消息与 owner 主动 Circles 操作。CLI 的 provider/账号与图片支持仍取决于原生合同；浏览器、电脑操作、自动多分身路由、无头消息 worker 等未全面移植。按 `/health` 和具体动作的实际能力降级，不能凭引擎或版本号推断支持。详见 [当前能力矩阵](../../docs/rust-capability-matrix.md) 与 [迁移契约](../../docs/rust-runtime-migration.md)。
  - 既有共享 8089 服务继续按所有权和接管规则处理：桌面自动启动/心跳对 VS Code、Local Helper 等外部 owner 的兼容服务保持 attach，即使同引擎且本地候选较新也不终止；新版本接管仅限桌面管理的服务。身份不兼容时报告冲突。默认候选为 Rust 不代表已有外部服务已被替换，实际引擎须检查 `/health.runtimeEngine` 与进程入口。
  - macOS 的 HTTPS 聊天页通过受限原生通道访问 `http://localhost:8089` / `http://127.0.0.1:8089`，避免 WKWebView 混合内容限制导致 MCP 在线但分身不显示。只接受实际受信顶层文档，Origin 取自原生框架，Bearer 认证和分身 owner 保持原协议；不使用 Cookie、代理、重定向或自动重试。响应按需流式读取，单次请求体上限 32 MiB；显式 Cookie 凭据、手动重定向等不支持的语义明确报错。Basic / Digest / NTLM 等系统认证挑战以 `MCP_HTTP_AUTH_CHALLENGE_UNSUPPORTED` 拒绝，不重新发送请求或伪造服务器响应。其他地址、端口和平台沿用浏览器连接，不修改网页存储或迁移分身记录。
- **双本地 Runtime 守护进程监管**：
  - 监管 MCP（`127.0.0.1:8089`，默认 Rust）与 `keepwork-local-model-node-runtime`（`127.0.0.1:18089`），60 秒心跳巡检。MCP 引擎选择不改变外部 VS Code / Local Helper 实例的所有权保护，也不放宽 Origin、鉴权、路径和任务执行边界。
- **网页唤起与首次引导**：
  - macOS 和 Windows WebView2 的受信任 AIChat 主页面可通过 `desktopScreenshotVersion: 1` 和 `captureScreenshot()` 调用 Rust 宿主截取主屏幕。聊天和桌宠共用授权。首次截图可选择本次、始终允许或取消，也可在 MCP 设置中撤销当前来源的授权。macOS 还需系统“屏幕录制”权限。截图只在内存中编码，通过 MCP 返回一个 JPEG（最多 3 MiB）及图像尺寸。macOS 使用主屏幕逻辑坐标，Windows 使用主屏幕像素坐标。
  - Bridge v1 可选 `launchIntents: true`，使用 `getLaunchIntent` / `onLaunchIntent` / `acknowledgeLaunchIntent` 与现有网页兼容；系统协议只接收 `keepwork-secondbrain://open` 和 `keepwork-secondbrain://onboarding`（可末尾 `/`），不接收query、fragment、目录、令牌或命令。
  - 冷启动与已有实例保留有效意图，直到可信主框架准备好；打开失败不确认消费。普通open只唤回窗口，显式onboarding可恢复向导；首次引导成功确认后不在每次普通启动强制重开。旧网页可忽略能力，新网页在旧宿主仍可手动打开向导，均不需要同步更新MCP。系统协议注册和实际浏览器唤起须用最终安装包单独验收。
- **透明置顶桌面宠物窗口（`pet.html`）**：
  - 对话框右上角的「−」临时隐藏桌宠并保留主窗口当前状态，「□」打开完整的 AIChat 主窗口，「×」收起对话框。单击桌宠可重新打开对话框，继续编辑草稿。
  - 跨屏拖动使用原生光标跟踪；切屏时网页暂停动画也能继续移动。macOS 在一次主线程调用中设置目标屏幕的画布位置与尺寸，避免不同屏幕高度导致偏移。超过 4px 才开始拖动，松手提交最终位置；旧轮响应不会移动或结束新一轮。旧宿主缺少原生跟踪标记时仍使用兼容轮询。
  - 右键或 macOS Control 点按宠物显示原生菜单：六档大小（0.5×–4×）、跟随 AIChat/抱抱龙外观、哈奇换宠入口、打开桌面、隐藏宠物和「完全退出…」。菜单不依赖登录或网络；缩放与外观持久保存，完全退出仍需确认气泡授权。打开或取消菜单保留当前草稿和语音状态，不触发左键展开或拖动；菜单显示失败在宠物中提示，可再次右键重试。
  - 宠物云端听写在宿主和页面均明确支持可选 `petDictationAudioVersion: 1` 时，由可见宠物采集 16kHz 单声道 PCM，隐藏主页面保留 SDK 识别、配置和草稿，开始听写不弹出主窗口。一次采集绑定原生点击、账号/目标 context 和主页面文档，音频仅在内存中按序传递并确认；停止、隐藏、打开主窗口、导航或账号/目标变化立即释放。权限失败和拥塞在宠物显示错误，首次系统麦克风授权仍正常出现。
  - 分身云端通话在双方均明确支持 `petDictationAudioVersion: 1` 和 `petVoiceAudioVersion: 1` 时，同样由可见宠物采集，点击「通话」保持主窗口原有的隐藏或最小化状态。整通通话持有同一次采集，仅聆听时向云端识别发送音频；静音、思考和播报期间的音频在本机丢弃，不缓存到下一轮。挂断、隐藏宠物、导航、账号/目标或识别引擎变化及异常会结束通话并释放采集。能力按实际声明协商，不要求桌面与网页版本一致；旧页面、未声明能力的宿主、其他识别引擎、主聊天通话和课堂录音保持原路径，macOS 仍可能唤起主窗口以满足 WebKit 可见性要求。已协商的宠物采集失败时显示错误，不自动改为主窗口采集。
  - macOS 14+ 主窗口禁用 WebKit 后台节流，隐藏时继续处理通话播放和取消回调；不显示或聚焦主窗口，也不改变麦克风授权。分身系统音色使用页面持有的原生 utterance，明确中文音色和正常语速，播完才恢复收音；旧 SDK 也可独立使用。原生回归见 `scripts/wk-persona-playback.swift`。
  - 固定工作区画布尺寸（`DESKTOP-PET-CLICK-STABILITY-001`），支持 `0.5×`–`4×` 缩放、抱抱龙/跟随 AIChat 宠物外观、快捷回复、语音听写/通话、完全退出分身/通道确认气泡（`#exit-bubble`）以及主屏截图权限审批气泡（`#permission-bubble`，连接 `~/.keepwork-mcp/pet-permission-bridge.json`，点击后先隐藏窗口再返回授权结果以确保气泡不入镜）。
- **本地文件夹授权、工作区文件读写与直连 PTY 终端**：
  - `src-tauri/src/files.rs`：管理 `folder-grants.json`、路径边界校验、软链接/目录联接安全规则与文件大小上限（PPT/PPTX 500 MiB、PDF 100 MiB、通用 1024 MiB）。
  - `src-tauri/src/brain_folder.rs`：管理 `<Documents>/MyBrain` 默认第二大脑文件夹预览与初始化授权。
  - `src-tauri/src/terminal.rs`：基于原生 PTY（Unix `libc::openpty` / Windows Shell）提供 `desktop:<id>` 会话、游标增量输出、窗口尺寸同步与中断控制。

### 小米遥控器语音输入

正常的 Tauri 客户端在「编辑 → 遥控器语音输入…」和系统托盘提供独立设置窗口，适配小米蓝牙语音遥控器 2 / 2 Pro（RC001 / RC003）。蓝牙连接、ATVV 音频解码与输入控制内置于 Rust 客户端，语音由 **Keepwork 云端 ASR** 转为文字，识别完成时直接输入到当前前台应用的输入焦点。无需安装 Python、下载本地语音模型或准备额外运行环境。此入口独立于 AIChat 网页和 MCP 版本；语音识别需要网络。`0.2.153` 起，Windows 10 1703（15063）及以上 / Windows 11 的 CEF 兼容宿主也通过随包原生语音进程复用该能力；Windows 7/8/8.1 显示明确的系统能力限制，麦克风语音输入和普通聊天仍可使用。兼容宿主的范围见 [Windows CEF 兼容说明](docs/windows-cef.md)，真实蓝牙与跨应用输入的验收状态见 [VALIDATION.md](VALIDATION.md)。

**0.2.76 起默认配对后自动开启。** 客户端启动后被动检查系统中已配对或已连接的小米 RC001 / RC003，只有找到唯一匹配设备才自动启用遥控器会话；没有候选设备时不主动扫描、不拦截 F5、不弹出设置，也不抢焦点。后台定时检查会继续识别之后的配对或唤醒。多个设备且未指定设备 ID 时不会任意选取，可在设置查看状态并指定目标；指定 ID 没有匹配时也不会改连其他设备。macOS 保存了指定 UUID 时，会只读找回系统认识的同一 UUID，并核对遥控器名称或语音服务，再定向连接；设备暂未连接也可重试。只读找回不代表设备当前仍已配对，不以 MAC 冒充 UUID。证据不足时保持等待并说明原因。

**多只遥控器的连接与选择。** 未指定设备 ID 时，若系统里配对了多只遥控器但只有一只处于连接状态，启动时直接连接这一只。macOS 只有配对地址、设备都在休眠时，仍显示「按一下要使用的遥控器即可自动连接」并继续检查。`0.2.192` 起，发现多只可连接设备时，设置窗口会直接显示名称和真实设备 ID，不默认选择第一只；选中后点击「连接所选遥控器」，客户端保存该目标供之后启动和唤醒使用，目标离线时不会改连另一只。可点击「刷新设备」重新查找；切换设备前先停止输入。选择语音设备不会解除按键来源不明时的物理按键限制。

**更换型号或语音服务缺失。** `0.2.199` 起，首次发现非空服务列表但缺少所需 ATVV 通道时，客户端先对同一设备重新连接一次；仍缺失时暂停，并提示「未发现本客户端支持的完整语音服务」。服务列表为空或曾成功协商的设备仍按原规则等待恢复。先断开电视或其他遥控软件、按键唤醒后重试；持续失败时，可手动复制设置中的诊断信息，并提供电池仓内的型号。诊断包含客户端版本、系统与架构、设备 ID、服务和特征 UUID、特征属性及缺失通道，不包含录音或识别文字。客户端不会向未知特征试写语音指令；是否需要新增协议适配须根据实际设备证据判断。这不影响普通聊天或电脑麦克风通话，也不代表已支持其他小米遥控器型号。

**0.2.182 起修复 macOS 启动连接。** 首次检测到唯一遥控器、开启了自动连接且主窗口处于前台时，若蓝牙授权尚未决定，客户端会触发一次系统蓝牙授权，允许后自动继续。后台启动、没有设备或目标不明确时不请求；已拒绝或受系统限制时不会重复请求，可在系统设置中授权。缺少辅助功能或输入监控权限时，仍需在遥控器设置中点击「启动语音输入」，按系统提示授予权限。从 Cursor、VS Code 或终端运行开发版时，请按系统提示中的应用名称授权。自动检测会重新检查权限；看到「已就绪」后，点击目标输入框，按住实体语音键说完一句话再松手。

**Mac 从睡眠中唤醒后**，客户端会重新连接睡眠前正在使用的遥控器，并等待系统蓝牙恢复。如果遥控器仍在休眠，先按键唤醒它，等设置显示「已就绪」后，再按住语音键说话。睡眠中断的听写会取消，需要重新录制。此前已点「停止」或关闭自动开启的空闲客户端会保持停用。

设置中的「配对后自动开启」开关会记住选择。取消勾选会保存关闭偏好并停止当前会话；重新勾选会解除本次进程内的停止或错误抑制，重新被动检查配对设备。关闭自动开启后，仍可点击「启动语音输入」临时使用，重启不会自动开启。单独点击「停止」只抑制本次客户端进程内的自动恢复，不改变开关偏好；重启后按已保存的偏好执行。有效的旧配置未保存此项时采用默认开启；配置损坏时关闭自动开启、显示错误并保留原文件，不自动覆盖。

1. 在系统蓝牙设置中配对遥控器，并先断开其与电视、盒子或其他桥接软件的连接。配对后的设备会按上述规则自动启用。需要查看状态或设置偏好时，从菜单或托盘打开「遥控器语音输入…」；展开设备与权限说明可填写 BLE 设备 ID 指定遥控器。窗口用操作卡说明语音、清除、主页和发送键的用法，并实时显示按键来源与可用状态。
2. 等待连接就绪；关闭自动开启或本次已经手动停止时，可点击「启动语音输入」。在设置中可点击「就绪，开始输入」隐藏设置、返回主窗口，再点击要输入的位置；此操作不恢复历史外部应用或光标。也可自行切到其他应用的目标输入框。按住遥控器语音键说话，客户端边采音边发送到 Keepwork 语音服务。松手后，客户端等服务确认最终文字再输入。macOS 上若要听写到其他应用，请先隐藏当前桌面的桌宠，再点选目标输入框。普通口述只输入文字，短按 OK 可另行发送。
3. 不再使用时点击「停止」，本次进程不会自动重新开启。若下次启动也要停用，关闭「配对后自动开启」。完全退出客户端会终止后台设备检测、录音、识别和输入控制并释放蓝牙连接；隐藏主聊天窗口或关闭设置窗口不等同于停止遥控器输入。

**实时通话。** 在 AIChat 主窗口或桌宠中，快速双击遥控器语音键即可使用「Digital Human Live · 豆包实时语音 3.0 · Pro」通话。松开后对着电脑麦克风讲话。通话使用 AIChat 原有的电话和麦克风权限。macOS 第一次请求麦克风权限时可在桌宠模式完成授权。主窗口与桌宠之间切换时通话会继续。通话期间，桌宠收起输入面板并保留草稿。麦克风准备好时，宠物头顶显示「聆听中」；通话状态与字幕分别显示。说完后宠物会显示「正在思考」，实际执行工具时显示「正在调用工具…」，回复开始后再切换到「正在说话」。你说的话会在宠物上方以黑底白字实时显示，说完后自动发送。AI 的回复显示在同一位置的浅色气泡中。点击宠物身上的红色电话按钮即可挂断。正在朗读时按一次语音键可立即打断并说下一句；正在聆听或等待回复时按一次可退出。在 macOS 上，讲解时按确定键可暂停讲解。实时通话中，AI 正在说话时按确定键会中断当前回复并继续聆听，按返回键可挂断。Windows 使用语音键退出。普通按住听写仍使用遥控器麦克风。

**普通听写。** 在 macOS 上，以下操作适用于当前桌面未显示桌宠时。AIChat 主窗口位于前台时，即使刚点过消息历史或工具栏，按下遥控器语音键也会聚焦当前聊天的消息输入框。写入识别结果前会再次检查焦点。正在编辑的搜索框、弹窗输入框和嵌入工具保留焦点。在其他应用中，点击要输入的位置后按住语音键即可。系统能定位当前可编辑输入框时，客户端沿输入框显示半透明的淡红色细框，焦点和选区保持原位。密码框或系统无法提供位置的控件会跳过红框。松手后，三个小点表示仍在等待识别结果。macOS 会在较小的输入框旁显示小点，较大的编辑区或位置未知时会显示在鼠标附近。Windows 会在鼠标附近显示小点。识别完成后，文字写入当时的光标处，小点随即消失。

**0.2.193 修复双栈网络下听写等待无文字。** 某些网络会优先解析到不可达的 IPv6 地址，使云端识别连接一直等到超时，即使 IPv4 可以正常连接。客户端现在对 IPv4 / IPv6 候选以 250 毫秒间隔错峰尝试 TCP 连接，连接阶段仍共用 15 秒期限；沿用固定 Keepwork 语音地址及原始 URL 的 TLS、Host、SNI 和证书校验。IPv6 保持可用；识别中断后不会自动重传录音。测试与真实硬件验收状态见 [VALIDATION.md](VALIDATION.md)。

**0.2.181 本地测试。** 针对 Keepwork 第二大脑主聊天框中听写后没有文字的问题，macOS 客户端会在受信任的聊天页面直接写入普通文字，并在输入框及草稿读回一致后才显示「文字已输入」。引号、换行和标签样式文字按原文写入，保留选区替换、附件引用及原生撤销与重做；该主聊天路径不改写剪贴板。目标改变或确认超时时，本段不会再次粘贴到其他位置。其他明确输入框、嵌入工具和外部应用保留当前焦点的系统输入行为，清除及发送口令保留既有规则。真实 WebKit 与独立 Tauri 主窗口的交付回归已通过，实体遥控器仍待用户验收；这是未发布的本地修复候选，尚未完整复现用户的硬件故障，验证范围见 [VALIDATION.md](VALIDATION.md)。

macOS 上，如果前台 Chrome 或 Electron 应用尚未提供输入框位置，首次按键时客户端会请求该应用启用辅助功能树，以获取控件边界。Windows 上，部分自绘编辑器只提供系统光标的位置，高亮会显示在光标旁。

**桌宠文字回复。** 输入框顶部显示 AIChat 主页面提供的当前对话；要切换会话，请在主窗口选择。搭配旧页面使用时，标题显示该页面实际提供的会话或分身。在桌宠输入框发送文字后，输入框立即收起，宠物显示思考动画。支持流式朗读的 AIChat 页面会使用当前配置的语音引擎，在答复生成期间开始播放正文；桌宠同时显示对应文字。页面与主聊天复用同一个 TTS 管线，图片、附件和工具输出会跳过。较旧页面保留回复结束后的系统朗读。点击正在朗读的回复可暂停，再点一次继续。朗读结束后回复会收起；无法朗读时，按文字长度显示约 3–15 秒。快捷回复仅在展开桌宠输入框时显示，收起后不会悬在宠物上方。

**桌宠听写。** 从 0.2.165 起，macOS 按住语音键时，只要桌宠在当前桌面空间（Space）可见，即使焦点在其他应用中，也会展开并聚焦桌宠输入框。该次口述的最终文字和整句「发送提示词」「清除提示词」只交给这次录音的桌宠会话。若在识别完成前隐藏桌宠或切换了桌宠会话，该次输入会取消。Windows 也优先将听写交给可见且未最小化的桌宠。输入框旁的黑底白色图标表示当前状态：圆弧旋转表示麦克风正在准备，声波跳动表示已开始采音。松手后红框消失，等待剩余识别结果时，输入框上方会显示三个小点。已有草稿可以继续编辑。

识别完成、文字已经出现在输入框后，**普通听写时短按遥控器 OK 键发送**。若 AI 正在朗读，确定键优先控制当前朗读。macOS 上，已确认来自小米遥控器的 OK 会把当前可见桌宠中已完成的草稿发送到该会话，即使桌宠悬浮在另一个前台应用上。桌宠空闲且草稿为空时，短按 OK 和单击宠物一样，会展开并聚焦已收起的输入框，再按一次就收起。桌宠隐藏时，OK 使用前台应用的原生 Enter 行为。普通键盘的回车、Windows 上的遥控器 OK，以及 macOS 无法确认来源的回车，也都由系统投递。请等听写结束后再按 OK。也可另按住语音键说一句 **「发送提示词」**：整段最终识别结果去掉首尾空白和末尾中英文句号、叹号或问号后，恰好等于该命令时，macOS 桌宠听写会在本次桌宠会话中执行发送。普通听写会向当前焦点发送一次 Enter，保留剪贴板。此时「已发送回车指令」表示按键已发出，目标应用按自己的 Enter 规则处理。命令字不会作为正文输入。请在 AIChat 回复结束、输入框可发送时使用；正在生成时 Enter 会按现有规则停止回复，其他编辑器可能只是换行。「请发送提示词」「解释一下发送提示词是什么意思」或正文后接「发送提示词」仍按普通口述输入；不匹配带引号的识别结果，也不模糊匹配同音词或内部空格。

**桌宠模式的工具确认。** 支持 `petApprovalRevealVersion: 1` 的桌面允许受信任的聊天主页面在显示工具确认框时调用 `aichatDesktop.revealPetApproval()`。当前显示着桌宠时，桌面会聚焦保留的主聊天窗口，等待用户选择允许或拒绝。桌宠已隐藏时，调用返回 `false`。若桌面还声明 `petApprovalReturnVersion: 1`，截屏确认可用 `revealPetApproval({ returnToPet: true })` 临时打开原本隐藏的主窗口。仅当调用返回 `true` 时，页面在用户决定后调用并等待 `returnToPetAfterApproval()`。桌面收起聊天面板、恢复桌宠并保留草稿。返回权仅限发起请求的当前文档，使用一次后失效；用户重新打开、移动或调整主窗口会取消自动返回。旧页面和旧桌面仍可通过桌宠的打开按钮或 Dock 回到聊天。

**主页键切换桌宠。** 短按 RC003 主页键可在完整 AIChat 窗口与独立桌宠之间切换。AIChat 处于最大化或全屏时也遵循这一行为。回到完整聊天窗口时，独立桌宠会收起。关闭「显示桌面宠物」后，主页键改为最小化或还原聊天窗口。在 macOS 上，如果其他应用占满屏幕工作区或处于原生全屏，主页键可在该应用上方显示或收起已启用的桌宠，原应用保持在前台。

**桌宠中的返回键与菜单清空键。** 遥控器实时通话期间，macOS 返回键与 Windows 菜单键优先挂断通话。平时只要当前桌面空间显示着可见桌宠，macOS 短按返回键或 Windows 短按菜单键就由桌宠处理，即使其他应用的编辑框中已有光标。每次短按只执行当前的一步：输入框有文字时清空草稿，输入框已空时收起输入框，输入框已收起时临时隐藏桌宠。临时隐藏会保留聊天窗口的状态和托盘中的「显示桌面宠物」设置。桌宠隐藏后，按主页键可在全屏或最大化窗口上再次显示桌宠，在普通窗口中则回到原聊天。

**物理清除键和语音清除。** macOS 在按键来源状态确认已找到唯一支持的小米 HID 设备时，可短按遥控器返回键（HID page `0x07` / usage `0xF1`，并非普通键盘的 F1 或 Escape）。Windows 内核键盘驱动（`kbdhid.sys`）会丢弃未映射的 HID usage `0xF1` 且系统阻止用户态直接读取 BLE `0x1812` HID 报告，因此 Windows 在确认唯一 Xiaomi RC003（`VID 0x2717` / `PID 0x32B8`）来源后，使用该遥控器的菜单键（`VK_APPS`）执行相同的清空与桌宠返回动作，并仅抑制该遥控器触发的上下文菜单弹出，普通键盘的菜单键不受影响。来源不明、多设备有歧义或当前系统不支持时，会显示物理清除不可用，不猜测其他按键，也不改写系统键位。按键来源变化后需先松开已按住的键，再重新短按；设备重连或来源更新不会把持续按住误当作新的清除操作。Windows 保留 OK 的原生 Enter，不映射电源键；两端均支持整句语音口令 **「清除提示词」**，沿用发送口令的精确整句匹配规则。

没有可见桌宠时（包括临时隐藏桌宠后），macOS 短按返回键或 Windows 短按菜单键会清空前台应用中已聚焦的普通可编辑文本框。听写文字出现在 AIChat 聊天输入框或外部编辑器后，即可直接短按清空整个草稿，无须再点击输入框；AIChat 主聊天输入框通过受信任页面编辑指令直接清空并保留原生撤销记录与剪贴板，外部编辑器在校验可编辑焦点后清空（密码框、只读控件、菜单弹出状态或按键处理期间改变的焦点不会被清空）。物理清除键还会取消当前录音和在途识别，丢弃迟到结果；语音键仍按住时丢弃到松手，不主动关闭 ATVV 通道，清除后不会被旧结果重新填回。语音「清除提示词」需要等待本段识别成功，不提供即时中断在途识别的能力。

macOS 首次使用需按系统提示授予 Keepwork 蓝牙、辅助功能和输入监控权限。权限拒绝或缺失时按窗口提示在系统设置中处理，不绕过系统授权。Windows 需要可用 BLE 适配器；向权限级别更高的应用粘贴可能被系统阻止。Linux 及 Windows 7/8/8.1 的原生 BLE 遥控器路径不在支持范围内。

首次连接或唤醒遥控器时，桌宠输入面板会提示连接进度。客户端收到语音键通知后会显示准备图标；未采到音频时会短暂显示重试箭头。在蓝牙协商音频格式期间收到的按键和音频会按顺序暂存于本次连接的内存中；即使先松手，已收到的完整录音仍可继续识别。若按键只唤醒了设备、蓝牙尚未上报音频，请在连接就绪后重新按住语音键。

ATVV 只在按住语音键时采集录音。请等识别完成后再录下一段；忙时按下的新段整段丢弃，不排队，也不接收后半句。就绪期间会全局预留 F5，实体键盘的 F5 也会被拦截；停止、断连或退出会释放。客户端不全局拦截 Enter 或 Escape；Windows 仅抑制已确认来自唯一 RC003 遥控器的菜单键松开事件以避免弹出右键菜单，普通键盘菜单键正常放行，且不改写系统设备 UserKeyMapping。普通听写使用识别结束时的当前光标，桌宠听写则使用按下语音键时的桌宠会话。普通口述不要求 WebView 提供可访问性选区信息，清除文本框时会确认当前焦点可编辑。执行客户端动作时如仍按住 Ctrl、Alt、Shift、Command 或 Windows 等修饰键，本次不执行，并明确提示「请松开修饰键」。通过系统粘贴输入普通口述时会替换原有剪贴板内容。

**长段口述与隐私。** 一次按住对应一次连续听写。客户端通过同一条 WebSocket 将 16 kHz 单声道 PCM16 音频陆续发给 Keepwork 语音服务 `wss://speechrtc.keepwork.com/speech`。短暂停顿时可以继续按住说话。主窗口和其他应用旁的桌面浮层、桌宠聊天框会显示服务返回的预览文字。后续识别可能修正先前的词句。松手后，客户端通知服务结束本次听写，等最终结果后才写入输入框或处理整句口令。音频和预览只保留在内存中。

一次听写正常结束后，下次按键可复用仍然可用的连接，每次听写的预览和文字独立。空闲连接在 60 秒后关闭。下次按键时，已连接满 10 分钟的连接会换新。停止、清除或退出会取消当前听写。

每次最多录 10 分钟，可暂存约 60 秒尚未送出的音频。若达到上限或本地解码中断，但云端仍确认了已连续送出的部分，客户端会提示录音不完整，并在松手后将这部分作为普通文字输入一次。即使文字恰好是“发送提示词”或“清除提示词”，也只会输入文字。断网、服务在松手前提前结束或最终结果超时时，预览会清除，不会自动重传或写入输入框。请查看设置中的状态，再重新按住语音键录制。

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
| `app/browser_surface.rs` / `browser_surface_macos.m` / `browser_surface_windows.rs` | 原生网页视图的发送者、URL、边界校验及隔离 WKWebView / WebView2 生命周期 |
| `app/main_window.rs` | 主文档生命周期、连接恢复、本地源码切换与缩放 |
| `app/native_startup.rs` | AppKit / Win32 / GTK 主窗口内原生加载层、失败重试与原位移除 |
| `app/host_menu.rs` | 原生命令执行、系统菜单、托盘与退出流程 |
| `app/pet_host.rs` | 宠物窗口、原生拖动跟踪、菜单操作与页面命令编排 |
| `app/pet_audio_host.rs` | 文档绑定的录音 IPC、私有音频投递、采集停止与超时监控 |
| `app/platform.rs` | 系统浏览器、文件管理器与平台调用 |
| `app/updates_window.rs` | 更新窗口、更新 IPC 与状态通知 |
| `navigation.rs` / `navigation_macos.m` | macOS 子框架导航策略与原 WebKit delegate 的事件转发 |
| `runtime.rs` | 运行时进程监管、所有权、重试、激活和回退；重导出原有运行时 API |
| `runtime/manifest.rs` | 清单类型、平台名称、版本比较与兼容性验证 |
| `runtime/archive.rs` | 受限路径 ZIP 解压、归档生成与摘要 |
| `runtime/staged_update.rs` | 下载、完整性校验与更新暂存 |
| `runtime/tests.rs` | 运行时单元测试与隔离回归测试 |

`app/` 内实现模块沿单向依赖组织；主窗口和宠物窗口共用独立的录音宿主，避免相互依赖。`tests/architecture-and-packaging.test.cjs` 随 `pnpm check` 检查 `src/` 与 `src-tauri/src/` 中维护的源码，每个文件不得超过 2000 行；增长时按职责继续拆分，生成文件和依赖不计入。

### 断网与页面连接恢复

正常的 Tauri / WebView2 路径从启动到工作台始终使用同一个主窗口。初始化期间主窗口保持隐藏，底层 WebView 使用原有配置档准备已配置的聊天入口。每次页面尝试最多等待 20 秒；只有受信任主文档满足下述就绪条件后，才移除原生覆盖层并一次显示工作台。失败时在同一窗口显示原生恢复操作「重试」和「稍后」，重试期间再次隐藏。后台启动与用户隐藏意图继续优先；迟到的就绪事件不会重新弹窗，尚未完成初始化时主动唤回也不提前展示 loading。

在恢复界面点击「重试」、按 `CmdOrCtrl+R` 或使用菜单「重新加载」，都会重试原入口。隐藏的本地连接页保留恢复调度：失败后依次等待 5、15、30 秒自动重试，最多 3 次；收到 `online` 事件时可提前触发下一次自动重试，并计入同一次数上限。达到上限后保留手动重试，手动重试会重新开始自动重试计数。重复触发不会并行加载，旧尝试的超时或就绪回执不会覆盖新尝试或已成功打开的页面。恢复流程不会自动切换线上与本地源码入口，也不会更换本地服务端口；诊断信息仅使用入口 origin，不显示查询参数或片段。

已经正常打开的聊天页不会因断网或恢复联网被桌面端自动刷新；恢复流程不会重发聊天消息或其他操作。云端模型、登录、同步和远端资源仍需要网络。本机已有的 MCP、文件及终端能力独立于外网连接，但页面打不开时，其网页操作入口也可能不可用；本地网页入口需要事先准备和配置。

就绪检测先等待主文档 `DOMContentLoaded`。对已知 AIChat 入口（`https://keepwork.com/chat` 或本地 Loopback 的 `AIChat.html`），优先读取网页已有的 `data-workbench-ready` 完成标志，并等待 `#startup-progress` 移除，不把初始外壳或 loading 占位当作完成。旧网页缺少标志时保留有效内容回退，忙碌根节点、纯加载控件和空聊天外壳继续等待；其他自定义入口或没有 `#app` 的旧页面保留主文档回退。显示前还等待当前适用的样式表及首屏字体完成，并计算布局，不依赖隐藏 WebView 可能暂停的动画帧。关键样式加载失败沿用 20 秒超时恢复。登录、回放确认等需要用户操作的可见界面可直接显示，不等用户在隐藏窗口完成交互。检测不等待图片、工具子框架、MCP 或全部后台请求，也不要求网页升级 Bridge v1；首屏就绪后即停止监听，不自动重放操作。

### 缓存与重复打开

托盘、宠物和单实例唤回直接显示已有页面，不重新导航或初始化。正常主 WebView 使用系统的持久网站数据，不主动清空缓存；远端资源是否能复用取决于各自响应头。完全退出后重新启动仍需执行网页初始化，不能把资源缓存等同于保存运行中的 JavaScript 状态。

本地源码与离线部署包的成功静态响应使用 `Cache-Control: private, no-cache` 和内容 SHA-256 ETag：每次验证当前文件，未改变时返回无正文的 `304`，修改后立即返回新内容，包含同大小编辑、入口 HTML 和包清单。删除、越界和链接逃逸继续拒绝且 `no-store`，不从缓存恢复无效路径。不改变稳定源码 origin、网页账号隔离或 MCP/API 缓存策略。网页主动使用 `fetch(..., {cache: "no-store"})` 的资源仍会重新读取，服务器的条件缓存不能覆盖这项选择。

## 开发与验证命令

### 日常启动与运行时选择

在 `apps/aichat-rust` 目录执行 `pnpm tauri dev` 启动桌面；默认构建并使用 **`apps/mcp-rust`**。VS Code 任务 `keepwork Rust Desktop: Start` 使用同一入口。macOS 上 VS Code 用登录 shell 启动该任务，因此会先采用开发者 shell 中的 pnpm PATH（官方安装脚本、nvm、fnm 通常写在 `~/.zshrc`），再执行同一条 `pnpm tauri dev`。`pnpm dev:rust` 保留为显式 Rust 别名。`pnpm dev` 只启动桌面页面的 Vite 服务，不启动桌面或 MCP。

默认入口需要 Rust/Cargo 工具链及桌面开发依赖；准备 Rust MCP 失败会停止启动并保留错误。Node.js 仍用于桌面开发工具和可选外部 CLI，并不表示 MCP 服务端使用 Node。`pnpm build` 只构建桌面前端，不会准备或覆盖 MCP 资源；运行时由开发启动器或 `make:*` / `bundle:mcp*` 命令准备。

Rust 开发启动与 Node 一样，每次在 `src-tauri/target/dev-mcp-runtime/rust-*` 独立目录准备运行时；不覆盖仍可能被存活 daemon 使用的资源目录或先前开发运行时。

需要 Node MCP 兼容能力时显式执行 `pnpm dev:node`，或设置 `AICHAT_MCP_ENGINE=node`。该路线要求 Node.js 22 或更新版本，以及仓库、`apps/mcp-runtime` 与桌面的已安装依赖；从当前源码生成独立的 Node 开发运行时，不依赖之前的 staging，也不自动安装或下载依赖。

如显式设置 `AICHAT_MCP_BUNDLED_DIR`（优先）或 `AICHAT_MCP_RUNTIME_DIR`，启动器会校验指定运行时与所选引擎一致；默认 Rust 入口不能借此静默加载 Node。目录设置只在下一次启动读取，不会动态切换运行中的 MCP。

Rust MCP 当前提供原生 ACP（含 WorkBuddy/CodeBuddy）、Codex、Claude 与 Antigravity 会话，以及审批、停止、状态流、AIChat 网页上下文工具桥和页面重连后的工具桥恢复。Codex/Claude 与明确握手支持图片的 ACP 可使用图片轮次；Antigravity 仍为文字。Codex 原生历史导入已实现，其他 provider 的原生历史目录导入、账户切换、Copilot 编辑器自定义模型和离线云端/Git 文件操作仍未提供。背景文件操作只支持明确授权的本机空间，远程文件仍需原网页在线。可选能力缺失时局部说明不可用，不自动切换引擎或 provider；须核验实际 `/health`，不能以桌面版本或源码升版推断共享服务已更新。完整范围见 [能力矩阵](../../docs/rust-capability-matrix.md) 与 [Rust MCP 说明](../mcp-rust/README.md#native-cli-sessions)。

开发页面固定使用 `http://127.0.0.1:1430`。重复启动会先检查开发服务的身份协议和真实项目目录，只复用同一 checkout 的服务。另一个项目、没有身份端点的旧 Vite 服务、无法确认身份的监听者会产生明确的端口占用错误；请在拥有该服务的终端中处理后重试。启动器不结束未知进程，也不自动换端口。关闭复用者不会关闭先前终端拥有的 Vite 服务；关闭原服务的终端后，需要重新启动开发服务。

AIChat 本地源码服务通过 `AICHAT_DESKTOP_LOCAL_SOURCE=1` 或「使用本地源码服务器…」启用，仅监听 `127.0.0.1`。首次从 `3001–3100` 中分配未占用、未保留的端口，将规范化源码目录与入口文件的绑定保存到应用配置目录的 `source-ports.json`。同一目录与入口在重复选择和重启后使用固定 origin，不同目录或入口保留独立端口。已绑定端口被占用、映射损坏或保存失败时明确报错，不自动换端口或接管其他服务。菜单切换源码时，候选服务器准备失败会保留当前页面与服务器；显式设置 `AICHAT_DESKTOP_LOCAL_SOURCE=1` 后启动失败，会记录错误、打开已有的备用入口，并显示一次原生错误提示，说明页面地址不同、原本地记录未搬迁以及重试方法。`deployment.json` 无法打开时保持既有的错误日志与 fallback 行为；其回退诊断只显示该入口的 origin，不包含其 URL 路径、查询参数或片段。

固定 origin 为同一浏览器配置下的本地会话选择、工具页和偏好提供稳定的存储边界。当前自动化验证覆盖地址复用与失败处理；浏览器存储及登录状态在真实桌面重启后的恢复仍需单独验收。旧版本随机端口下的本地数据不会自动搬迁；网页与桌面之间沿用现有云同步规则，当前会话选择和已打开工具页仍只保存在各自本地。

修改启动配置不会停止当前运行的服务；新选择在下次桌面进程启动时生效。默认运行时选择决定本次桌面启动使用的候选，不能证明已存在的共享 MCP 已切换。外部 VS Code / Local Helper 的服务仍受所有权与接管规则保护；验收必须检查实际 `127.0.0.1:8089/health` 的引擎与目标能力，不能仅检查打包目录。需要切换已有服务时，先确认所有者和活跃任务，再按实际启动方式受控重启；不能自动重放未确认结果的任务。

### Windows 签名与自动安装

Windows 发布工作流支持仓库 Secrets `WINDOWS_CERT_PFX_BASE64`（含代码签名私钥的 PFX，Base64 编码）和 `WINDOWS_CERT_PASSWORD`。配置后先对 Rust MCP 签名，再生成资源清单；Tauri 对桌面程序和 NSIS 安装包签名，最后验证安装包及解包后的程序签名和证书指纹。未配置证书时工作流明确告警，生成的仍是未签名测试包。证书须支持 CI 签名；依赖硬件或云签名服务的证书需要对应签名提供程序。

原生 Tauri 安装器在安装、覆盖和卸载前，使用本版本打包的 `--stop-desktop <可执行文件路径>` helper 终止目标安装目录内仍在运行的 `Keepwork.exe` / `aichat-rust.exe`（包括隐藏到托盘或宠物的桌面进程），确认退出后再用 `--stop-mcp <安装目录>` 停止该目录内的 MCP。选择“安装前卸载”时，此关闭步骤在运行旧版卸载器之前完成；仅打开或取消安装器不会关闭应用。原生 Windows API 核对完整可执行文件路径，保留同一进程句柄并等待退出；不按进程名全局结束进程，不影响其他安装或 VS Code / Local Helper 的服务，也不运行 PowerShell 脚本。无法核验路径、权限不足、终止失败或等待超时时，中止替换或删除文件，并以中文显示具体原因及处理建议，保留已下载更新包。兼容 Launcher 安装器使用独立流程，不适用上述桌面终止逻辑。

每个安装器或卸载器只在自己的临时插件目录中解压一次辅助程序，后续关闭与检查操作复用该文件，避免重复覆盖刚运行或仍被安全软件扫描的可执行文件。首次解压失败时，以中文显示失败步骤、目标路径和排查建议并中止操作；不会允许忽略错误后继续替换或删除应用文件。

此解压修复从 **0.2.125** 的安装器与其生成的卸载器起生效，不能追溯修改已经安装的旧卸载器。若旧卸载器仍提示无法写入临时目录中的 `keepwork-installer-helper.exe`，运行新版安装器时选择“请勿卸载”，覆盖安装以更新卸载器，再正常卸载。选择“安装前卸载”仍会运行旧卸载器，可能再次遇到旧问题；覆盖安装保留用户数据，卸载时仍按用户选择的数据清理选项执行。

新安装的登录自启动默认关闭，已有开关偏好保留。新版本在后台下载并校验后，于完全退出时静默覆盖原安装目录；点击“重启并更新”则在覆盖后重新打开应用。自动更新交接仍先核对原进程的 PID、创建时间和可执行文件路径并等待正常退出；身份核验失败或等待超时时中止本次更新并显示中文原因。更新包须位于下载目录且通过大小和 SHA-256 校验。开发版、便携版和兼容 Launcher 不走此原生覆盖路径。覆盖安装保留用户配置、聊天数据和工作区；卸载仍按用户选择的数据清理选项执行。MCP ZIP 更新在 Rust 内解压，支持 Zip64 和 data descriptor。

这些措施不能保证杀毒软件不误报。确有误报时应保留告警名称、被隔离文件路径和 SHA-256，向对应厂商提交样本复核；提交样本会向厂商上传二进制，应由发布负责人执行。现有 GrokX 的历史检测不能证明 Keepwork 的具体触发原因。

```bash
# 类型检查与前端构建
pnpm typecheck
pnpm build

# Rust 单元测试与冒烟测试（5 套核心测试及 macOS 原生启动场景）
cargo test --manifest-path src-tauri/Cargo.toml --features dev-bins
pnpm smoke

# 完整检查（TypeScript + Vite + Cargo Test + Node 契约测试）
pnpm check

# 自带 Rust MCP 运行时（从仓库根目录执行）
node apps/aichat-rust/scripts/bundle-mcp-rust.cjs --target universal-apple-darwin
```

`pnpm smoke` 保留原有 5 套 Rust 核心冒烟测试，并在 macOS 执行真实 Tauri / OS 原生窗口与 WKWebView 的隔离启动场景。该场景仅在 `dev-bins` 下编译，使用仅监听 Loopback 随机端口的私有 HTTP 服务、临时配置档与存储，不连接真实 `8089`，不启动运行时 supervisor、托盘、语音或账号流程。覆盖已有 loading 外壳和延迟关键样式时主窗口持续隐藏、首屏完成后一次显示、主窗口及 WebView 身份保持、恢复层覆盖和就绪后的文档焦点；也覆盖后台启动、失败恢复界面关闭或按 `Esc` 后迟到的就绪事件，以及 20 秒超时后在原窗口重试并隐藏准备。

`pnpm check` 运行完整检查；上述隔离冒烟用于验证源码中的启动流程，不代表已安装发布包、真实账号或 Windows 实机验收。

标准冒烟一次构建所有目标，并从 Cargo 的 JSON 产物记录取得实际可执行文件路径，兼容自定义输出目录。单独运行 `scripts/startup-native-smoke.cjs --no-build` 且使用自定义 Cargo 配置时，应显式传入 `--executable=<已构建的 startup-smoke 路径>`。

Rust binary 的 `--build-info` 返回编译时 `version`、`commit`、`target`、`sourceHash` 和 `capabilities`，不受宿主运行时身份环境变量覆写。捆绑脚本先验证所有目标的二进制身份、当前源码指纹及必需能力，再写资源；`--no-build` 也会拒绝旧版、同版过期或缺少能力的产物，不能用新 manifest 版本包装旧 binary。打包成功后仍须核验实际 `127.0.0.1:8089/health` 的运行身份与能力，并检查 `/agents/backends`；本地产物通过不代表运行中的共享服务已经更新，也不代表真实 CLI 生成验收通过。

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

### GitHub Release 与 CDN 下载地址

从 2026-11-13 起，后续桌面发布统一使用标准 `v<主版本>.<次版本>.<补丁版本>` 标签，例如 `v0.2.112`，标签中的版本必须与四处桌面清单一致。此约定同时记录在根目录 [AGENTS.md](../../AGENTS.md#rust-desktop-release-tags-appsaichat-rust)，供后续开发和发布遵循；其他产品继续使用各自独立的版本与标签约定。

在 `v<版本>` 标签上手动触发 [Rust 安装包发布工作流](../../.github/workflows/aichat-rust-windows-release.yml) 时，默认 `edition=all` 同时构建现代版和 Win7/Win8 x64 专版。现代 Windows x64 / ARM64 EXE 与 macOS Universal DMG、Windows 产物验证清单和 `SHA256SUMS-<版本>.txt` 汇总为 `aichat-rust-release-packages`，专版另存为 `aichat-rust-win7-win8-x64` artifact。仅现代版可显式选 `edition=modern`，仅专版选 `win7-win8`。GitHub 不再上传七牛或公开 Release；创建或推送标签也不会自动发布。

产物由此设备通过 `http://127.0.0.1:7890` 下载，本地核对 run ID、完整源提交和校验和后，由此设备直连七牛上传。七牛凭据使用本机环境中的 `KP_QINIU_ACCESS_KEY`、`KP_QINIU_SECRET_KEY`，不写入命令参数或仓库。三个安装包全部通过 CDN 大小与 SHA-256 校验后，本地发布器才提升三个更新 feed、在 GitHub Release 正文顶部写入可点击的 CDN 下载地址，最后上传附件并公开 Release。新建 Release 在失败时保持草稿；重跑时保留原说明并替换同一自动下载区块。

历史 `aichat-rust-v<版本>` 标签、Release 与下载地址保留原样，发布脚本仅为重跑已有历史发布保留旧标签兼容；不再新建旧格式标签，也不通过重命名、移动或重建历史标签调整显示顺序。标准标签便于 GitHub 识别版本，但不保证所有历史 Release 严格按版本倒序；`Latest` 标记与列表顺序是两回事。

版本安装包使用存储端禁止覆盖策略；同版本重跑只接受内容一致的已有 CDN 文件。CDN 返回 404 也不会授权覆盖源站已有对象。发生内容冲突时应复用原构建产物或发布新版本，不能覆盖 GitHub 附件来绕过校验。

此发布流程使用按版本存放的安装包路径 `https://cdn.keepwork.com/keepwork/aichat-rust/<版本>/<安装包文件名>`，以及 Rust 专用的 `win32-x64`、`win32-arm64`、`darwin-universal` 三个自动更新 feed；历史 Electron / Launcher 地址保持原状。只有对应版本完成实际上传和校验后，该版本的下载链接与更新清单才可视为已发布。

从仓库根目录下载与预检。每次下载使用全新输出目录，默认只预检，不上传：

```bash
node .github/skills/rust-release/scripts/download-artifacts.cjs \
  --product desktop --run-id <构建runID> --commit <完整源提交SHA> \
  --output .tmp/rust-release/desktop-<构建runID>
node .github/skills/rust-release/scripts/publish-local.cjs \
  --product desktop --artifacts .tmp/rust-release/desktop-<构建runID> \
  --version <版本> --commit <完整源提交SHA> --tag v<版本>
```

实际发布时给第二条命令显式添加 `--publish true`。所有 GitHub `gh` 子进程（包括 Release 附件上传）均强制使用本机代理并剔除七牛密钥；七牛发布器自身清除代理后直连七牛。代理不可用、身份不匹配或验收失败时中止，不回退到 GitHub 上传七牛。保留下载目录不变，发布日志和新增回执存到目录外，避免重试时文件清单校验失败。

独立 MCP 四个现代目标也采用同样的本机下载和上传路径。其证据验证需要仓库根目录的 Node 依赖，尚未安装时先运行 `npm ci --ignore-scripts`，已有依赖可复用。默认 `/rust-release` / `all` 还必须通过专版发布器上传 Win7/Win8 客户端、专用 MCP 和 CEF；实际发布显式选择 `legacy-signing=production` 并保留三系统验收门禁。完整流程与验收要求见 [rust-release Skill](../../.github/skills/rust-release/SKILL.md)，`modern` 模式保留仅现代双产品发布。

已有本地安装包仍可使用原入口预览 CDN 发布计划（不上传）：

```bash
node apps/aichat-rust/scripts/publish-release.cjs --release-dir dist --version <版本> --dry-run
```

## Win7 / Win8 x64 专版（兼容预览）

独立专版面向 Windows 7 SP1 x64、Windows 8 x64、Windows 8.1 x64，使用原生 C++ Launcher、CEF109 和共享源码构建的兼容版 Rust MCP，安装到 `KeepworkWin7Win8`。默认完整预览包内置同信任根签名的 CEF109 归档；薄包首次无缓存时需要联网下载。保留基础文件、搜索和普通 `run_terminal`；交互式 WinPTY 终端按运行服务实际声明的 `terminalApi` 能力提供，后端未就绪时仅终端功能降级。不提供现代 Tauri Bridge，MCP 启动失败仍可打开云聊天。

`0.2.164` 修复兼容宿主「浏览本机文件夹…」的系统选择器入口：确认选择后由网页原有 MCP 流程验证路径并连接工作空间，取消或过期结果不改变工作空间。宿主声明独立的 `nativeFolderPickerVersion: 1`，`pickFolder()` 仅返回 `{ path }` 或 `null`，不声明完整 `files` 能力；文件读写仍依赖本地 MCP。已发布网页的已知控件由宿主适配，无需同步更新网页或 MCP；未知布局保留页面原有行为。Windows 7/8/8.1 的真实系统选择器交互仍待分别实测。

`0.2.153` 为兼容宿主的宠物对话面板增加语音输入、通话 / 结束通话和静音；使用同一 AIChat 主页的账号、草稿与语音设置，麦克风需要用户授权。文字输入支持 Enter 发送、Shift+Enter 换行，输入法确认候选不会误发送。麦克风音频由受信任主页采集，原生窗口仅操作原有宠物协议；语音和文字能力均不要求同步升级 MCP。Windows 7/8/8.1 的真实设备、CEF 录音及通话仍待分别实测。

此入口与前述历史通用 CEF 预览分开，构建和更新渠道独立于现代版。使用 [rust-release 的 Win7/Win8 流程](../../.github/skills/rust-release/references/windows7.md) 准备专版；完整支持范围、完整包/薄包区别和逐系统验收以 [Windows CEF 兼容说明](docs/windows-cef.md) 为准。现代 Windows 构建或单份 MCP smoke 不能代表三个旧系统的安装、CEF、登录和更新已验收；本轮开发未执行发布。

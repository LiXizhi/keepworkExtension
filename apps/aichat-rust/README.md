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
  - **Keepwork MCP Runtime 热更新（`:8089`）**：后台从 `https://cdn.keepwork.com/keepwork/mcp-stable/<platform>-<arch>.json` 检查更新，流式下载 `.zip`，校验文件大小、SHA-256、40 位源码 Commit 与 `runtime.json` 启动配置，暂存至 `mcp-runtimes/<sha256>`，支持在「检查更新」窗口一键应用或在下次重启时自动激活，启动失败自动回滚。
  - **桌面客户端自动更新（Desktop Self-Updater）**：启动后 15 秒及每 6 小时检查 `https://cdn.keepwork.com/keepwork/aichat-desktop/<target>/latest-client.json`（或 `AICHAT_UPDATE_FEED_URL`），后台自动下载更新包并校验 SHA-256，持久化 `update-metadata.json`（离线时保留上次检查缓存并标记 `stale: true`）。用户在独立「检查更新」窗口（`updates.html`）点击「更新桌面应用」并确认后退出并启动新版本安装。
- **自带的 Keepwork MCP Server（与 `apps/aichat-desktop` 一致）**：
  - 安装包内直接携带 `apps/mcp-runtime` 运行时：`scripts/bundle-mcp-runtime.cjs` 在打包前把 `apps/mcp-runtime/staging/<platform>-<arch>` 校验（product / 平台 / 架构 / 版本 / 40 位源码 Commit / node 与入口文件 / 陈旧检测）后复制到 `src-tauri/resources/mcp-runtime/<arch>/`，由 Tauri `bundle.resources` 打进 `.app` / NSIS 安装包。
  - 启动时按当前架构选择 `resources/mcp-runtime/<arch>`（macOS universal 包同时携带 arm64 与 x64 两份运行时），没有自带运行时才回退到 DesktopLauncher 已安装版本或 CDN 热更新，因此首次安装即可离线使用本机 MCP 能力，来源显示为 `AIChat Desktop / NodeRuntime`。
  - `pnpm build` 在缺少 staging 时只告警；`pnpm make:mac` 与 `make:win:x64` 使用 `--require`，缺运行时、运行时陈旧或不是 `npm run stage` 产物（例如手工 symlink 的调试运行时）都会直接失败，避免发出没有自带 MCP 的安装包。上游暂未发布 `windows-arm64` staging，因此 `make:win:arm64` 安装包继续从 CDN 获取运行时。
  - **Rust 守护进程（预览）**：`pnpm make:mcp-rust:mac` 把 `apps/mcp-rust` 的二进制按架构放进 `resources/mcp-runtime/<arch>/{runtime.json,bin/keepwork-mcp}`（清单 v2：`product: keepwork-mcp-runtime`、`engine: rust`），宿主发现 Rust 运行时后直接执行 `entry`（不再 spawn Node），并关闭该构建的 MCP 热更新，避免被 Node feed 覆盖。Rust 线目前到 P1：文件面板（`/fs/*` 全量）、文件夹选择（`/fs/locations|browse`）、终端（PTY）、`run_terminal`/`grep_files`/`web_search`/`fetch_url` 均可用；Agent、消息、人格、浏览器、电脑操作等能力尚未移植，AIChat 会按能力缺失降级；详见 [迁移契约](../../docs/rust-runtime-migration.md)。
- **双本地 Runtime 守护进程监管**：
  - 监管 `keepwork-mcp-node-runtime`（`127.0.0.1:8089`）与 `keepwork-local-model-node-runtime`（`127.0.0.1:18089`），60 秒心跳巡检，启动时自动识别并平滑接管低版本 `runtimeVersion` 的本机 MCP 进程，同时保护外部（VS Code / Local Helper）管理的同版本或高版本实例。
- **透明置顶桌面宠物窗口（`pet.html`）**：
  - 固定工作区画布尺寸（`DESKTOP-PET-CLICK-STABILITY-001`），支持 `0.5×`–`4×` 缩放、抱抱龙/跟随 AIChat 宠物外观、快捷回复、语音听写/通话、完全退出分身/通道确认气泡（`#exit-bubble`）以及主屏截图权限审批气泡（`#permission-bubble`，连接 `~/.keepwork-mcp/pet-permission-bridge.json`，点击后先隐藏窗口再返回授权结果以确保气泡不入镜）。
- **本地文件夹授权、工作区文件读写与直连 PTY 终端**：
  - `src-tauri/src/files.rs`：管理 `folder-grants.json`、路径边界校验、软链接/目录联接安全规则与文件大小上限（PPT/PPTX 500 MiB、PDF 100 MiB、通用 1024 MiB）。
  - `src-tauri/src/brain_folder.rs`：管理 `<Documents>/MyBrain` 默认第二大脑文件夹预览与初始化授权。
  - `src-tauri/src/terminal.rs`：基于原生 PTY（Unix `libc::openpty` / Windows Shell）提供 `desktop:<id>` 会话、游标增量输出、窗口尺寸同步与中断控制。

## 开发与验证命令

### 日常启动与 Rust MCP 预览

在 `apps/aichat-rust` 目录执行 `pnpm tauri dev` 启动桌面；日常开发使用完整的 **Node MCP**，以保留 WorkBuddy、Codex 等原生 CLI 会话能力。VS Code 任务 `keepwork Rust Desktop: Start` 使用同一默认入口；这里的 Rust 指桌面客户端，不表示选择 Rust MCP。`pnpm dev` 只启动桌面页面的 Vite 服务，不启动桌面或 MCP。

常规启动需要 Node.js 22 或更新版本，并已安装仓库、`apps/mcp-runtime` 与本桌面的依赖。启动器从当前源码生成独立的开发运行时，使用当前 Node 和已安装依赖，不依赖之前的 staging，不自动安装或下载依赖；准备失败时停止启动并保留错误。缺依赖时，在仓库根目录执行 `npm ci`、`npm ci --include=dev --prefix apps/mcp-runtime`，并在本桌面目录执行 `pnpm install` 后重试。

如显式设置 `AICHAT_MCP_BUNDLED_DIR`（优先）或 `AICHAT_MCP_RUNTIME_DIR`，常规入口会校验并使用指定的 Node 运行时，不覆盖该目录。默认 Node 开发目录也不会被旧的 Rust 打包资源覆盖。

需要验证 **Rust MCP 预览** 时显式执行 `pnpm dev:rust`，或为开发启动器设置 `AICHAT_MCP_ENGINE=rust`；这个选项不会切换运行中的 MCP。Rust MCP 当前尚未提供原生 CLI 会话接口，不能用该入口验收 CLI 连接器；版本号较大也不代表支持这些能力。详细边界见 [运行时迁移契约](../../docs/rust-runtime-migration.md#当前可用的桌面运行时选择)。

开发页面固定使用 `http://127.0.0.1:1430`。重复启动会先检查开发服务的身份协议和真实项目目录，只复用同一 checkout 的服务。另一个项目、没有身份端点的旧 Vite 服务、无法确认身份的监听者会产生明确的端口占用错误；请在拥有该服务的终端中处理后重试。启动器不结束未知进程，也不自动换端口。关闭复用者不会关闭先前终端拥有的 Vite 服务；关闭原服务的终端后，需要重新启动开发服务。

默认运行时选择决定本次桌面启动使用的候选，不能证明已存在的共享 MCP 已切换。外部 VS Code / Local Helper 的服务仍受所有权与接管规则保护；CLI 验收必须检查实际 `127.0.0.1:8089/health` 的 `agentSessionApi` 和目标平台接口，不能仅检查打包目录。若仍连接到不支持 CLI 的 Rust 预览服务，先确认其所有者和活跃任务，再按实际启动方式恢复完整运行时。

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

# 自带 MCP 运行时：先 staging，再让打包带上它
npm run stage --prefix apps/mcp-runtime -- --platform darwin --arch arm64
npm run stage --prefix apps/mcp-runtime -- --platform darwin --arch x64
pnpm bundle:mcp --target universal-apple-darwin
```

## 多平台打包矩阵

| 平台 | Rust Target | 构建命令 | 产物 |
| --- | --- | --- | --- |
| **macOS Universal**（Apple Silicon + Intel 单包） | `universal-apple-darwin` | `pnpm make:mac` | `Keepwork.app`、`Keepwork_<版本>_universal.dmg` |
| **Windows x64** | `x86_64-pc-windows-msvc` | `pnpm make:win:x64` | `Keepwork_<版本>_x64-setup.exe` |
| **Windows ARM64** | `aarch64-pc-windows-msvc` | `pnpm make:win:arm64` | `Keepwork_<版本>_arm64-setup.exe` |

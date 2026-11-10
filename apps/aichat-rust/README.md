# KeepWork 第二大脑 (`apps/aichat-rust`)

基于 **Rust + Tauri 2（WRY 原生系统 WebView）** 构建的 **KeepWork 第二大脑（AIChat Desktop）** 跨平台桌面客户端，参考 `grokx` 项目的 Rust + Tauri 2 架构对原 Electron 版 `apps/aichat-desktop` 进行完整重构，不再依赖 Electron / Chromium 运行时。

## 核心能力与架构

- **主聊天窗口与 34px 顶部自定义标题栏**：
  - 加载 `https://keepwork.com/chat`（或本地 Loopback `AIChat.html` 开发源码 / `deployment.json` 离线包）。
  - 在受信任顶层主框架注入 Closed Shadow DOM 的 `#keepwork-desktop-titlebar`（34px 高度、应用图标、Windows/Linux 内联菜单、居中标题、地址胶囊、刷新按钮，并实时同步页面深浅色与皮肤 CSS 变量）。
  - 注入只读冻结的 `window.aichatDesktop`（Bridge v1）契约，对现有 Web 端 `desktop.js`、`keepwork_fs.js`、`desktop_menu.js` 保持 100% 兼容。
- **菜单协议 `aichat.desktop-menu.v1` 与命令路由（对齐 `apps/aichat-desktop`）**：
  - 菜单载荷同时提供桌面版形状 `menu: { id, label, items }` 与冗余兼容字段 `menuId` / `items` / `anchor` / `x` / `y`，菜单项标签与 `CmdOrCtrl` 加速键、`shortcut`（macOS `⌘ ⇧ ⌥`）与桌面版逐项一致。
  - **页面命令**（`new-chat`、`toggle-sidebar`、`toggle-files`、`open-settings`、`experience-simple`、`experience-professional`、`theme-light`、`theme-dark`）只投递给 AIChat 页面；**主机命令**（`open-folder`、`reload`、`check-updates`、`toggle-login`、`quit`、编辑/缩放/全屏/开发者工具、`mcp-status`/`mcp-dashboard`/`mcp-restart`、`open-browser`、`local-source`、`published-site` 等）由桌面进程原生执行，未知 id 一律拒绝。
  - 旧 id（`file:open-folder`、`view:reload`、`view:reset-zoom`、`help:check-updates` …）由 `canonical_host_command` 规范化，原生菜单/托盘与历史页面调用方继续可用；原生托盘与 macOS 系统菜单同样可以投递页面命令。
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

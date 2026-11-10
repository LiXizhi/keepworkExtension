# `apps/aichat-rust` 验证与冒烟测试清单

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
  - `lipo -archs <Keepwork.app>/Contents/MacOS/aichat-rust` 确认同时包含 `x86_64` 与 `arm64`。
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

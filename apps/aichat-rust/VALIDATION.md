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

# Windows CEF 兼容启动

Windows 兼容启动方案用于处理 WebView2 不可用的机器，包括 Windows 7 / 8。它提供一个能在旧系统运行的原生启动器，在启动现代 Rust / Tauri 程序之前选择宿主。CEF 不是 Tauri 2 中可动态加载的 DLL 插件，必须连同针对该 CEF 版本编译的宿主一起发布。

这是一条单独的兼容构建路径。现有 Windows Tauri 安装包及 macOS / Linux 路径继续使用原来的 WebView。兼容安装包不内置 CEF；首次进入 CEF 路径需要联网下载完整宿主包，之后使用经过验证的本地缓存。

**0.2.42 是首版预览实现，尚非生产发行版。** 已准备 Windows 构建工作流与发布工具，但本次未运行该工作流，未完成 Windows / Win7 实机验证，也未上传 CDN。下文描述实现契约和验证方法，不表示发布链路已在线可用。

## 首版能力边界

| 能力 | 现有 Tauri / WebView2 路径 | CEF 首版 |
| --- | --- | --- |
| 云端 AIChat 聊天、登录 | 保持现有行为 | 加载 `https://keepwork.com/chat`，使用独立浏览器 profile |
| 桌面 Bridge v1 | 保持现有行为 | 不注入 `window.aichatDesktop`，不宣称未实现的桌面能力 |
| 托管 MCP 与本地模型进程 | 保持现有行为 | 不启动、不接管 |
| 文件夹授权、原生文件操作、PTY | 保持现有行为 | 尚未移植 |
| 桌面宠物、托盘、桌面菜单与更新窗口 | 保持现有行为 | 尚未移植 |
| 本地 AIChat 源码服务器 | 保持现有行为 | 首版不提供 |
| 麦克风、摄像头和网页剪贴板权限请求 | 保持现有行为 | 拒绝权限请求，语音 / 视频等依赖这些权限的功能不可用 |

CEF 首版定位为云端 AIChat 的兼容窗口，不代表 Windows 7 已达到现有桌面端功能对齐。浏览器页面是否能使用另外安装的本地服务，仍由页面自身的能力协商、服务可用性和权限决定；兼容宿主不替这些服务承诺 Windows 7 支持。

兼容窗口标题为「Keepwork — 兼容模式」，关闭窗口即退出，没有隐藏到托盘的行为。主窗口限制为 Keepwork HTTPS 页面；登录弹窗仅允许配置的 Keepwork 登录路径以及 Google、微信、飞书 / Lark、钉钉提供商。常规外链经过策略检查后交给系统浏览器。第三方登录流程还需要实际账号验证，白名单测试通过不代表 OAuth 流程已测试。网页标准文件上传仍可用，从主窗口的 Keepwork 页面发起下载时显示“另存为”对话框；这些浏览器交互不等于开放原生文件 Bridge。

CEF 与 WebView2 使用不同的浏览器数据目录，切换后可能需要重新登录。不要复制两种内核的 cookie 数据库，也不要因切换内核重放待执行操作。原有 Rust 侧配置和工作区授权保持原位置。

## 内核选择与系统边界

- Windows 10 及更高版本：WebView2 可用时启动现有 Rust / Tauri 客户端；不可用时选择现代 CEF 宿主包。
- Windows 7 SP1 / 8 / 8.1：选择 legacy CEF 宿主，不尝试先启动现代 Rust 程序；不支持未安装 SP1 的 Windows 7。
- 普通网页加载失败、登录失败或网络中断，不应被当作 WebView2 缺失。
- 当前阶段仅能声明经过构建和实测的体系结构，不能因为 CEF 上游存在某架构就承诺其安装包可用。

CEF 宿主使用同一 Windows 会话内的固定单实例锁，覆盖所有 CEF 通道和 profile。启动器在探测 WebView2 之前检查已有 CEF 实例；若兼容窗口已打开，要求先使用或关闭该窗口，再切换内核或更新，避免跨内核重复启动。

首版兼容安装包构建脚本只提供 **x64 和 ARM64**，其中 Windows 7 目标为 **x64**。虽然宿主协议和 CEF109 源码支持 x86 构建，本次没有提供 32 位 Windows 的兼容安装包。

现代 CEF 包默认最低系统为 Windows 10 build 19045；发布者可根据具体 SDK 的实际测试结果设置更高或更低的 `minWindows`。启动器会执行这个下限，不能把“Windows 10”整体视为已测试平台。

Windows 7 使用 **CEF 109**，它是最后兼容该系统的官方分支，已经停止维护。现代 Windows 使用另外构建、验证和锁定版本的现代 CEF 包；“最新版”不等于给 Windows 7 下载现代 CEF。新旧 CEF 的宿主和 DLL 不能混用。相关系统边界见 [CEF 官方分支支持表](https://github.com/chromiumembedded/cef/blob/master/docs/branches_and_building.md)和 [Windows 7 / 8 支持结束公告](https://groups.google.com/g/cef-announce/c/Lpw5PP5LPNc)。

独立宿主按照 CEF 的 Windows 沙箱架构构建：CEF 109 将 `cef_sandbox.lib` 链接进宿主 EXE；现代 CEF 使用 SDK 提供的 `bootstrap.exe` 和宿主 DLL，并将沙箱上下文传给 CEF 初始化与子进程入口。不可通过 `--no-sandbox` 解决打包或启动问题。现代 CEF M138 起的这一构建要求见 [CEF 官方沙箱说明](https://github.com/chromiumembedded/cef/blob/master/docs/sandbox_setup.md)。这与把当前应用升级到 Tauri 3 alpha 是不同的实现路径。

外层启动器必须自身兼容 Windows 7。当前应用使用的 Tauri 2.12 已停止官方 Windows 7 支持，单纯在它的 `main` 中增加 OS 判断不能消除 Windows 加载器的失败。详见 [Tauri 2.12 公告](https://v2.tauri.app/blog/tauri-2.12/)。仓库原有 Electron 下载启动器使用 Go 1.25，也不能直接作为 Windows 7 入口；[Go 1.21 起要求 Windows 10](https://go.dev/doc/go1.21)。

## 下载、缓存与发布契约

CEF 分发包需要包含匹配版本的宿主 EXE、CEF 二进制、子进程所需文件、locale 和其他资源，不能只上传 `libcef.dll`。构建时确定 CEF 版本，应用启动时选择经过发布验证的包，不从上游任意获取 DLL 替换。

发布清单通过 RSA-2048 / SHA-256（PKCS#1 v1.5）签名，启动器使用内置公钥和 Windows BCrypt 验签，再检查包的下载大小和 SHA-256。私钥只用于发布签名，不进入源码、安装包或下载缓存。操作系统代码签名与清单签名是不同环节，不能相互替代。

包先下载并解压到暂存目录。解包必须限制条目数量和总大小，拒绝绝对路径、路径穿越以及可写出暂存目录的成员。宿主完成本地空白页渲染并发出原生就绪信号后，才将候选缓存置为当前版本；中断下载、校验失败、解包失败或启动失败不能覆盖已验证的可用缓存。

新的 CEF CDN 命名空间需要单独发布，不应覆盖现有桌面更新和 MCP feed。仓库代码或测试 fixture 中存在 URL 并不代表该 URL 已有可下载产物。**本次未执行任何 CDN 上传或对外发布。** 首次发布必须先构建实际 Windows 包、完成验收、配置匹配的签名公钥，再发布清单与包。

启动器约定的 CDN 根路径是 `https://cdn.keepwork.com/keepwork/aichat-cef/v1/`：

- 清单：`<legacy|modern>/windows-<x86|x64|arm64>/stable.json`，legacy 不接受 ARM64。
- 宿主包：`objects/<sha256>.zip`，包地址由校验后的摘要推导，不接受清单指定的任意下载 URL。
- 兼容安装的现代 Rust 客户端更新清单：`client/windows-<arch>/latest-client.json`，与常规 Tauri 安装包 feed 隔离，更新时保留外层兼容启动器。显式 `AICHAT_UPDATE_FEED_URL` 仍优先于默认路径。
- 本机缓存：`%LOCALAPPDATA%\Keepwork\BrowserRuntimes\<channel>\<arch>`，其中 `active.json` 保存已验证的清单，`versions\<sha256>` 保存对应文件。
- CEF profile：`%LOCALAPPDATA%\Keepwork\CefProfiles\<channel>-<chromiumMajor>`。大版本升级使用不同目录，可能需要再次登录。

兼容启动器的常用参数：

```powershell
# 自动检测系统和 WebView2
.\Keepwork.exe

# 强制进入当前系统对应的 CEF 通道，使用已验证缓存
.\Keepwork.exe --cef

# 重新读取该通道的发布清单，下载并验证候选版本
.\Keepwork.exe --update-cef
```

首版默认使用可用缓存，不在每次启动时联网更新 CEF；使用 `--update-cef` 主动检查。更新失败会保留原来的 `active.json`，再次正常启动可使用旧缓存。发布新内核不会让已经运行的进程自动切换。`--background` 可以与以上参数组合；CEF 宿主以最小化窗口启动，首版没有负责唤回窗口的桌面托盘。

这里的失败处理是保留旧版本，不是自动重新启动旧版本：首版不会在启动失败后读取 `previous.json` 并自动切换。中断下载也没有断点续传，重试从头下载；若进程异常退出留下暂存目录，启动器会报错要求在关闭 Keepwork 后移除该暂存目录，再重试。不要删除 `CefProfiles` 中的浏览器数据。

WebView2 检测会实际创建控制器。启动现代 Rust 程序时，启动器还通过 `--webview-ready-event` 等待主窗口就绪；只有主 WebView 创建失败对应的明确退出码 `86` 才触发后续 CEF 回退。普通崩溃、等待超时或网页错误均不触发自动切换，避免掩盖其他启动问题。

## CEF 宿主构建与策略测试

以下命令从 `apps/aichat-rust` 目录执行。宿主需要匹配目标架构的 Windows CEF binary distribution。构建用下载器从 CEF Automated Builds 的 HTTPS 索引选择匹配通道的最新稳定 standard SDK：legacy 只选 109，modern 只选 138 及以上。下载时验证索引中的大小与 SHA-1，并额外记录 SHA-256 供重复构建锁定；这是构建工具，最终用户仍从 Keepwork CDN 下载已经构建、验签的宿主包。

```powershell
# Python 3.12；每次使用新的输出目录
python scripts/fetch-cef-sdk.py --channel legacy --arch x64 --output build/sdk-legacy
python scripts/fetch-cef-sdk.py --channel modern --arch x64 --output build/sdk-modern

# 重复构建时复用记录的版本和 SHA-256，不重新选择最新版
python scripts/fetch-cef-sdk.py --channel modern --arch x64 --output build/sdk-modern-repeat --lock build/sdk-modern/cef-sdk-lock.json
```

输出目录中的 `cef-root.txt` 给出 SDK 的绝对路径，`cef-sdk-lock.json` 记录所选版本、架构和摘要。将 `CEF_ROOT` 指向该路径。CEF 109 必须包含 `Release/cef_sandbox.lib`，现代 SDK 必须包含 `Release/bootstrap.exe`。不要用不带沙箱资源的 SDK 绕过构建检查。

```powershell
# Windows + MSVC，x64 示例；Win32 / ARM64 应选择对应架构和 SDK
cmake -S windows/cef-host -B build/cef-legacy -A x64 -DCEF_ROOT=C:/sdk/cef109
cmake --build build/cef-legacy --config Release

# 使用另一个构建目录生成现代宿主
cmake -S windows/cef-host -B build/cef-modern -A x64 -DCEF_ROOT=C:/sdk/cef-modern
cmake --build build/cef-modern --config Release
```

输出位于各构建目录的 `payload/Release/`，其中 `cef-host.json` 记录版本、架构与沙箱模式。这个目录用于后续签名和生成 CDN 包，不复制到 Tauri `resources` 或兼容安装包。现代宿主为官方 bootstrap EXE 加 `keepwork-cef.dll`，legacy 宿主为链接沙箱库的 EXE。

宿主入口为 `keepwork-cef.exe --profile <绝对路径> --ready-event <原生命名事件>`，通常由兼容启动器调用。`--background` 使主窗口初始最小化。就绪信号在主框架完成初始 `about:blank` 加载后发送，随后才导航到聊天页；它覆盖本地渲染器与沙箱启动，不依赖远端网站请求成功，因此断网不会被误判成内核启动失败。若同一 Windows 会话已有 CEF 实例，宿主返回退出码 `17`；不能把旧实例的运行状态当作候选包就绪。

导航策略测试不需要 Windows 或 CEF SDK，可在开发机运行：

```sh
cmake -S windows/cef-host -B build/cef-policy -DKEEPWORK_POLICY_TESTS_ONLY=ON
cmake --build build/cef-policy
ctest --test-dir build/cef-policy --output-on-failure
```

## 兼容安装包与 CDN 文件准备

发布方需要一对持久使用的 RSA-2048 PEM 密钥。示例中的 `C:/release-keys/cef-public.pem` 与 `cef-private.pem` 是发布方准备的路径，不是仓库提供的密钥。不要提交私钥；若更换公钥，需要重新分发固定该公钥的启动器。

CEF 宿主的所有二进制修改和代码签名都应在生成分发清单之前完成。打包脚本读取宿主构建生成的 `cef-host.json`、检查 PE 架构和资源文件、生成 ZIP 与签名清单：

```powershell
# 生成 legacy CEF109 包；默认最低系统为 Windows 7 SP1
node scripts/cef-release.cjs package build/cef-legacy/payload/Release build/cef-release C:/release-keys/cef-private.pem

# 生成现代 CEF 包，最后的最低系统参数可选
node scripts/cef-release.cjs package build/cef-modern/payload/Release build/cef-release C:/release-keys/cef-private.pem 10.0.19045

# 若单独编译原生启动器，可先生成只含公钥的 C++ 头文件
node scripts/cef-release.cjs key-header C:/release-keys/cef-public.pem build/cef-release-key.hpp
```

输出包括 `objects/<sha256>.zip`、通道清单和 `release-plan-<channel>-<arch>.json`。它们是待审查、待上传文件；脚本不会上传 CDN。发布时先上传不可变 ZIP 对象，确认下载与摘要，再发布相应通道的 `stable.json`。不能改写已发布 SHA-256 路径下的内容。

发布工具默认仅校验签名、大小和摘要并输出计划，不写 CDN：

```powershell
node scripts/publish-cef.cjs build/cef-release legacy x64 C:/release-keys/cef-public.pem
node scripts/publish-cef.cjs build/cef-release modern x64 C:/release-keys/cef-public.pem
```

发布负责人在完成 Windows 验收并核对计划后，才可显式添加 `--publish`。真正发布使用 `KP_QINIU_ACCESS_KEY` / `KP_QINIU_SECRET_KEY`，先上传和验证宿主 ZIP，再更新通道清单。本次没有执行发布。此工具只处理 CEF 宿主通道，不发布兼容安装包的客户端更新 feed。

兼容安装包使用已准备的现代桌面 payload，再编译并加入原生启动器。payload 应包含对应架构的 `aichat-rust.exe` 及其所需资源；这个脚本不替代 Tauri / MCP 构建：

```powershell
node scripts/build-windows-compat.cjs --payload C:/build/modern-desktop-payload --output C:/build/compatible-installer --key C:/release-keys/cef-public.pem --arch x64
```

该步骤需要 Windows、MSVC / Windows SDK、CMake 和 NSIS。CEF 宿主包与兼容安装包是两个独立产物：不要把前面的 `payload/Release` 目录作为这里的现代桌面 payload，也不要将 CEF DLL 放进安装包。开发或发布机器使用 Node / Python 不意味着最终用户需要安装它们。

构建输出为 `Keepwork-Compatible_<version>_<arch>-setup.exe` 和描述其大小 / 摘要的 `compatible-installer.json`。每次使用新的输出目录；现存安装 staging 目录会使构建停止。安装目标为当前用户的 `%LOCALAPPDATA%\Programs\KeepworkCompatible`，开始菜单入口为「Keepwork 兼容版」，与常规桌面安装路径分开。卸载保留浏览器 profile 和已验证下载缓存。

安装包描述包含预定下载地址 `https://cdn.keepwork.com/keepwork/aichat-cef/v1/client/windows-<arch>/<installer>`；它和同目录的 `latest-client.json` 仍需另行发布。生成描述中的 URL 不代表安装包或更新清单已存在，不能将其当作已上线链接。

兼容打包脚本不自动执行 Authenticode 代码签名。正式发布需为启动器、宿主和最终安装包安排对应的签名 / 验签步骤；签名改变文件内容后，必须重新生成受影响的包摘要、签名清单或安装包描述，不能继续发布旧摘要。

## 手动 Windows 预览工作流

[`.github/workflows/aichat-rust-cef.yml`](../../../.github/workflows/aichat-rust-cef.yml) 提供手动触发的 x64 预览构建：构建现有 Rust 客户端和 MCP、生成不含 CEF 的 NSIS 安装包、下载并分别构建最新匹配的 legacy / modern SDK，以及执行原生校验工具和策略测试。产物分别携带安装包、CEF 宿主包、SDK 锁文件和预览公钥。

该工作流每次生成独立临时 RSA 密钥，私钥不上传 artifact 并在任务结束时删除；它不是正式发布的信任根。预览安装包与包清单只适合隔离验证，不能直接替换正式通道，工作流也不写 CDN。本次尚未运行此工作流；即使工作流构建通过，也不能替代 Win7 虚拟机中的安装、渲染、登录和下载验证。

## 必须执行的 Windows 验收

源码检查、跨平台单元测试和 Windows 编译均不能替代 Windows 7 实机或虚拟机验收。发布前至少记录以下场景的系统版本、架构、CEF 版本、启动结果与日志：

1. Windows 10 / 11 已安装 WebView2：仍启动现有桌面客户端，文件、终端、宠物及 MCP 行为不受影响。
2. Windows 10 / 11 无 WebView2：下载现代 CEF 包，完成聊天页加载和登录；普通断网不引发错误的内核切换。
3. Windows 7 SP1 和目标 Windows 8 系统：安装器与外层启动器能运行，下载 legacy 包，CEF 109 能创建窗口、加载页面并保持登录。
4. 下载中断、取消、重试、错误签名、错误大小 / 摘要、不匹配的内核或架构、恶意 ZIP 路径：不运行未验证文件，不覆盖旧缓存。
5. 候选宿主崩溃或未发送就绪信号：不激活失败候选；已有缓存可继续用于启动。无缓存且离线时给出下载失败原因。
6. 再次启动与缓存目录包含中文 / 空格、非管理员安装、CEF 子进程创建和退出：行为正确，无额外主窗口或后台残留。
7. 页面外链、弹窗、跨域跳转与下载：按首版宿主策略处理，不意外向页面开放原生权限。
8. 安装目录已有 MCP / 其他 Keepwork 实例：兼容路径不抢占其端口或结束不属于自己的进程。

Windows 7 的 TLS、根证书、签名验证和运行库补丁状态必须纳入实测。不要为了绕过下载失败而关闭 HTTPS 证书校验。CEF 109 与当前 AIChat 网页之间的 JavaScript / Web API 兼容性也需要验证，不能由“窗口成功打开”推断聊天功能全部可用。

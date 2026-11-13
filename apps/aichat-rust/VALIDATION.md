# `apps/aichat-rust` 验证与冒烟测试清单

## 2026-11-13：自动更新的运行时所有权与冒烟修复（0.2.91）

按 AGENTS 三角色流程继续处理下方 `0.2.86` 完整检查失败，不把原有失败记录改成通过。兼容的 VS Code / Local Helper 服务即使早于本机捆绑版本，也保持原 PID 和所有权；桌面仅附加并显示实际观测到的运行版本、引擎、commit 和构建时间，缺失字段保持未知。桌面与 MCP 的更新检查继续独立，外部服务不被自动更新、重启或退出流程误杀。

替换桌面自有旧服务前复验 PID、owner、引擎、版本及 commit；身份变化、服务已升级或元数据变为未知时保留实际服务，不沿用第一次探测作停止决定。停止后仍有监听者时明确提示未启动替换服务。HTTP 健康失败不能证明端口空闲：首次启动和失败回滚的通用启动入口都要求 TCP 明确拒绝连接，端口仍占用或状态无法确认时保留监听者并报告冲突，不启动第二个候选。

端口守卫拒绝与候选实际启动失败分别处理；候选从未尝试，或竞争监听者使验证结果不确定时，保留 pending/current，不把包误标失败或伪报激活成功。只有候选经实际存活子进程、PID 与健康身份核验后才提升 current；确认失败且端口空闲时继续回退已验证版本。不会自动重放结果未知的工具调用或用户任务。

本轮回归使用临时配置档、随机回环端口、可控健康响应及测试自建子进程，覆盖外部 owner、复验期间身份变化、停止后监听仍在、HTTP 非成功或无效响应、候选与回滚受竞争监听阻断、pending 保留及正常启动/激活。五项桌面冒烟覆盖 desktop、runtime、PTY、pet 和 updates；更新冒烟仅下载并准备合成安装包，不启动安装器。额外真实 AppKit / WKWebView 冒烟验证原生启动窗口、前后台就绪、关闭 / Esc 后迟到就绪不弹窗，以及实际 20 秒失败后重试。

继续修复过程中保留两类失败：原生冒烟的测试专用 NSApp 子类导致 Tao `sendEvent` 递归并栈溢出，改为仅替换测试进程的 activation selector；隔离网页入口的就绪回执同时绑定实际 source / entry，旧二进制结果不代替重新构建后的整套验证。`0.2.90` 完整检查还暴露 source server 文件服务 / 路径遍历夹具的端口探测后释放竞态。`0.2.91` 由该夹具直接绑定 `127.0.0.1:0`，将原 listener 交给私有 `serve_listener`，不释放后重绑；生产路径仍经过 `source_identity`、`bind_source_origin` 和注册表，来源稳定、范围耗尽、端口冲突及路径隔离规则保持原样。

最终通过数与完整检查结果待 `0.2.91` 重新构建及执行结束后补充，不以早前版本或旧二进制结果替代。本轮未操作共享 8089、真实账号或硬件，未发布 CDN 或替换用户安装，不据此宣称 Windows / macOS 真实安装升级已验收。四处桌面版本保持同步 **0.2.91**。

## 2026-11-13：AGENTS 三角色复核与冒烟修复

完整检查曾实际触发 `primary_button_is_up_without_a_held_click`：该旧用例直接读取真人鼠标状态，却未控制“左键已松开”的前提。首轮失败及执行期间源码漂移保留在 `.test-runtime/rust-agents-final/desktop/`。经产品/QA确认，常规CI改为两项可控macOS/Windows掩码解析回归，并复用现有拖动/释放状态机；真实系统采样断言保留为显式ignored，须在解锁桌面且主键松开时单独执行。OS调用、fallback与生产拖动策略不变，不以重跑碰巧通过代替稳定修复；后续完整检查使用新的 `desktop-r2` 证据目录。

并行任务持续写入版本和构建输入后，最终验证移到字节核对一致的隔离源码副本及独立编译缓存。隔离检查又复现浏览器超时夹具的空PID文件竞态：旧shell可能在重定向建文件后、写入PID前被正确超时终止。现将原等待循环拆为接收自有Child的helper，生产spawn/期限/kill/wait行为不变；测试直接以Child.id验证同一进程的超时、退出和已回收状态，无额外等待、重试或忽略。失败记录与修前源码保留，后续新源码指纹的完整检查及桌面/原生启动smoke回执见 `desktop-snapshot-r2`。

产品 Agent 与 QA 重新确认兼容契约后，程序员 Agent 修复启动选择与身份显示：同一引擎启动按已验证 current/bundled 的最高版本选择，不自动采用较旧或同版不同 commit 的 pending；显式 Node 不被历史 Rust cache 选回。附加服务的缺失版本、commit、构建时间和引擎保持未知，重连不继承上一实例身份。已验证 Node 候选的旧健康响应可省略 engine，但仅限本次存活 Child、匹配 PID 和正确服务身份；Rust v2 不放宽其明确引擎合同。

本轮先保留定向复现失败，再修复并执行完整 `pnpm --prefix apps/aichat-rust check`、五组桌面 smoke，以及 MCP 的单元/契约/构建、双引擎 wire、已提取 v2 包的真实二进制 smoke。MCP 冒烟脚本本身增加逐次 POST 的身份/所有权验证和有界清理回归。最终命令、计数、跳过及源码指纹以 `.test-runtime/rust-agents-final/` 与本轮 MCP 回执为准，旧版本通过记录不代替本轮。

共享 TypeScript/布局/固定 vendor 与已提交 canonical 快照分别核验。相邻 AIChat 四个模块仍有未提交修改，默认 auto/canonical 检查保留该差异，未自动提交或同步外部进行中的工作；`check:shared` 不据此标成全绿。Windows 干净机、真实平台协议注册、账号和硬件不从本机夹具结果推定通过；未触碰共享 8089 或发布清单。

## 2026-11-13：恢复桌面自动更新发布契约

根因是 Rust 发布器仅上传版本化安装包并写入 GitHub 下载链接，没有刷新客户端仍订阅的 `aichat-desktop/<target>/latest-client.json`；旧清单的顶层 ZIP 也不能由 Rust 的 EXE / DMG 安装路径直接使用。保留启动后 15 秒及每 6 小时检查，桌面与 MCP 改为并行检查，桌面包下载并通过完整性校验后通知，安装仍须用户确认。

发布契约：先上传并校验全部版本化安装包，再更新 Windows x64 / ARM64 与 macOS arm64 / x64 四个清单并验证 CDN 结果。已有清单顶层 legacy ZIP 字段全部保留，追加独立版本与发布日期的 `installer`；没有旧清单时顶层描述原生安装包。拒绝清单倒退或同版本不同安装包，不修改 Launcher 的签名 `stable.json`。新版 Rust 优先读取 `installer`，旧格式原生安装包保持可用；坏清单或下载失败保留缓存与实际错误，不能把不支持的 ZIP 宣称为可安装。旧 Rust 不识别 `installer`，须先手动安装本修复版才能接回后续自动更新，不宣称旧客户端可自动自救。

验收覆盖：四平台清单、legacy 字段保留、版本与包身份防回退、发布顺序及各阶段失败阻断；客户端新旧清单、无更新、包大小 / 摘要失败、离线缓存，以及 MCP 检查阻塞时桌面仍完成检查。自动化使用本地清单与随机回环服务；结果以本轮实际测试回执为准。本段不表示已发布 CDN、已替换用户应用，或已完成 Windows / macOS 真实安装升级。

本轮 `0.2.86` 实际验证：

- `pnpm --prefix apps/aichat-rust typecheck` 与 `pnpm --prefix apps/aichat-rust build` 通过。
- `cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins updates::tests --lib`：6 项通过，覆盖原生 / 历史 / 独立版本清单、ZIP 不支持、坏清单、下载失败缓存身份及 MCP 响应延迟时桌面仍下载完成。
- `cargo run --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins --bin updates-smoke`：通过；仅准备隔离测试包，不启动真实安装。
- `node --test apps/aichat-rust/tests/*.test.cjs`：424 项通过、5 项跳过；发布与更新定向 68 项全部通过。`node --test scripts/rust-validation-workflows.test.cjs`：4 项通过。
- 完整 `pnpm --prefix apps/aichat-rust check` 未全通过：最新运行的 Rust 测试 202 项通过、1 项忽略，`runtime::update_tests::older_vscode_and_local_helper_peers_keep_ownership_even_when_a_newer_bundle_exists` 失败（预期 attached，实际 error）。该失败位于工作区原有运行时改动，本次未修改其实现；不可据此宣称完整应用检查通过。

## 2026-11-13：Rust 产品优化、兼容检查与证据留存

本轮增加可选 Bridge v1 `launchIntents`：严格系统协议、单实例转发、可信主文档私密能力票、pending/ack 和首次引导标记。Rust MCP 使用独立 `mcp-stable-rs` v2 feed；Node v1 保留。下载只暂存，应用更新及后续宿主启动沿用激活流程，候选健康通过后才提交 current；普通重启保留 previous，失败优先回退上一个已验证运行时。缺失/过期候选、较新实时服务、外部 owner 及 Local Model 无 PID 的旧健康接口分别有隔离回归；ZIP 提供条目和展开大小上限。

PR 校验加入 Windows/macOS 原生回归、强制 Node/Rust 对照、真实二进制 target 的本地 v2 产物与失败日志。`rust-validation-evidence.cjs run/collect/verify` 保存源码指纹、命令、日志摘要与未执行 gate；源码变化和日志被改写会拒绝复用回执。最终执行结果保存在仓库 `.test-runtime/rust-optimization-final/`，按产品独立收集。完整执行入口与证据层级见 [Rust 发布验收清单](../../docs/acceptance/rust-desktop-release.md)。

本机验证命令：

```sh
pnpm --prefix apps/aichat-rust check
pnpm --prefix apps/aichat-rust smoke
node --test scripts/rust-validation-workflows.test.cjs scripts/rust-validation-evidence.test.cjs
node scripts/sync-aichat-runtime.cjs --check --mode packaged
node scripts/build-node-reference.cjs
KEEPWORK_MCP_REQUIRE_NODE_REFERENCE=1 node --test scripts/contract/*.test.cjs
```

所有本轮自动化使用隔离 profile、测试子进程或随机回环端口，不操作共享 8089、真实渠道或用户账号。不把 macOS 夹具扩展成 Windows 干净机、系统协议实际注册、官网唤起、真实模型首问、遥控器或麦克风验收。相邻 AIChat 的 canonical `text_tool_calls.mjs` 与已打包副本不同；显式 packaged 检查及对照构建不会修改 vendor，canonical 检查继续报告真实差异。未上传或提升任何 CDN 清单。

## 2026-11-13：macOS 发布页连接本机 MCP 与分身（0.2.82）

用户提供的同页对比中，Chrome 能显示三个分身，已安装桌面 `0.2.78` 没有显示；本机内置 Rust MCP `0.2.44` 健康并声明 `personasApi`，但没有 AIChat presence。隔离实测确认：macOS 15.7.9 的 WKWebView 在 HTTPS 页面访问 HTTP loopback 时，在请求抵达服务器前失败。同一自有 HTML 改为 HTTP 来源即可访问；精确 ATS 例外及 WebContent ATS 例外均不能解决。没有采用关闭 WebKit 安全检查或迁移分身 owner 的方案。

主窗口现在安装受限 `WKScriptMessageHandlerWithReply`；HTTPS 可信顶层页的既有 `fetch` 在访问精确 `localhost:8089` / `127.0.0.1:8089` 时使用该通道。原生独立核对实际 WebView、主框架 URL 与 securityOrigin，强制真实 Origin、固定回环目标、保留 Bearer 与 owner，拒绝 Cookie、代理、重定向及非法头；其他请求仍由原浏览器执行。响应按消费拉取，每块最多 64 KiB、缓冲最多 1 MiB、最多 32 个请求，请求体最多 32 MiB。取消不重发，导航开始和提交均清理旧请求。Basic / Digest / NTLM 认证挑战明确返回 `MCP_HTTP_AUTH_CHALLENGE_UNSUPPORTED`，避免 Foundation 自动重新发送请求；Bearer 401 保留原始 HTTP 状态和正文。

已执行验证：

- `pnpm --prefix apps/aichat-rust check` 最终通过：TypeScript、前端构建，Rust **168 通过 / 1 默认忽略**，Node **384 通过 / 4 平台跳过 / 0 失败**。日志 `/tmp/keepwork-macos-mcp-check.log`。初次沙盒运行禁止回环夹具；放行隔离测试后的一次运行遇到既有鼠标按键采样测试，最终重跑通过。
- 新增 JS 合同测试 **10/10**；真实 WKWebView 夹具 **1/1**，实际加载生产 JS shim 与原生实现，仅在测试副本替换随机端口。覆盖旧 health 的可选字段缺失、旧 MCP initialize/session、分身列表、二进制、SSE/NDJSON、Abort、标准 Response 读取及 iframe/来源/端口/头部/重定向隔离。Bearer 401 与 Basic / Digest / NTLM 场景均断言每个 POST 只收到一次。
- `cargo build --offline --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过；日志 `/tmp/keepwork-macos-mcp-build.log`。`git diff --check` 通过。

所有自动回归使用自有 HTML、临时配置和随机回环 mock，未替换已安装应用或改变真实分身数据；尚未对登录账号执行修复版整窗验收。四处桌面版本同步 **0.2.82**；网页和 MCP 服务不要求同步升级。安装包发布使用 `aichat-rust-v0.2.82` 标签及 `AIChat Rust release packages` 工作流，三个平台的安装包完成 CDN 大小与 SHA-256 校验后才公开 GitHub Release；完整下载地址写入 Release 正文及 Actions 发布摘要，沿用按版本禁止覆盖的 CDN 路径。

## 2026-11-13：聊天页面等待 SDK 时的真实首屏（0.2.81）

用户截图的黑色画布来自已进入 `localhost:3001` 的 AIChat 文档：`startup-progress` 已出现，但 `initTheme` 仍在等待包初始化、Tailwind、SDK 和工作台模块，因此基础 CSS 的默认深色先绘制。前两轮仅覆盖本地连接页及已应用主题的页面，遗漏了此阶段。

AIChat 源码现在在样式表之前只读解析 URL、手动偏好或本地 07:00–19:00 调度，以临时根标记提供首帧颜色；body 初始化后立即接管并移除标记，运行时首次选色采用相同规则。桌面同时对已配置、受信任 AIChat 顶层入口注入一次性预主题，兼容旧网页；菜单切换入口时复用现有有效页面票据，在文档仍有效、URL 未变化且工作台未接管时补齐，不新增 IPC 或放宽 URL 校验。根标记、临时样式和观察器及时撤销，后续用户/宿主切换与皮肤正常接管。bootstrap 入口只含 origin/path，不暴露 query、fragment 或凭据。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript 与前端构建通过；Rust **168 通过 / 1 实连默认忽略**，Node **373 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-real-startup-check.log`。桌面专项 **127/127** 是完整检查的子集，涵盖预主题、作用范围、单次执行、有效/拒绝/迟到票据及入口隐私。
- AIChat 真实 HTML/CSS 浏览器启动回归 **28/28**：挂起真实包模块或 SDK 请求，在只有原始进度条、空工作台时采样实际背景和标题栏颜色。覆盖新网页独立运行、新桌面注入新网页、新桌面注入旧缓存页面，手动亮暗、自动时段边界、URL/query/hash 优先及不可读存储。日志 `/private/tmp/keepwork-real-startup-final.log`，截图 `AIChat/.test-runtime/screenshots/startup-theme-rust-manual-{light,dark}.png`；亮暗截图已视觉复核。
- 保存的真实修复前 HTML/CSS 在 `web startup manual-light` 场景确定失败，日志 `/private/tmp/keepwork-real-startup-before/result.log`；这是工作树源码对照，不是历史版本实连。现有工作台主题调度浏览器回归最终 **2/2**，日志 `/private/tmp/keepwork-real-startup-schedule-tap.log`；首次报告异常失败已保留说明，不计为通过。
- Web 主题源码行为测试 **17/17**，包组成/契约/资源检查 **32/32**；库存检查通过（91 个源包、3 个配置）。JavaScript 语法、JSON 与两仓差异检查通过。未运行 AIChat 的 Vite、构建、部署或发布命令。
- `cargo build --offline --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，日志 `/private/tmp/keepwork-real-startup-native-build.log`，本地开发程序已重新编译。

本轮使用隔离 SDK/网络夹具，没有真实账号或模型请求；不把 Chrome 注入脚本验证等同原生 macOS/Windows 整窗实测。修改源于 `apps/official/apps/tools/AIChat` 与本仓桌面，各自独立生效，无需更新 MCP。四处桌面版本同步 **0.2.81**。

## 2026-11-13：亮色启动主题记忆（0.2.80）

修正上一轮启动页按系统外观取色的规则：现在启动和连接恢复使用本配置档最近一次受信任聊天页的亮暗模式，无有效记录时默认亮色；系统深色不再覆盖应用亮色。主题独立保存至 `desktop-theme.json`，不修改旧 `settings.json` 或网页 origin 的偏好。原生窗口显示前设置主题与不透明背景；本地页面在当前状态快照返回前保持透明且不绘制正文/标题栏，随后统一应用 `status.theme`，避免恢复时使用过期启动缓存。

宿主按已验证主窗口 URL 区分 shell，启动/恢复页的主题报告不改写记忆；无 CSS 主题信号的 `confirmed:false` 报告同样不覆盖，旧调用省略该字段保持有效。状态字段 `theme` 为可选新增字段，旧宿主缺失或返回未知值时本地页默认亮色。主题写盘失败仍保留本进程最新外观，不阻断聊天或恢复。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript 与前端构建通过；Rust **167 通过 / 1 实连默认忽略**，Node **337 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-light-startup-check.log`。
- 标题栏、连接页和菜单专项 **91/91**；`cargo test --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --features dev-bins theme::tests` **6/6**。覆盖快照等待时不报告系统猜测、保存主题压过系统、无记录默认亮色、聊天主题接管、同进程恢复/下次启动、配置档隔离、旧设置不变及写入失败后保留内存主题。
- Chrome 隔离页面 **8 个启动组合**通过：TypeScript / Rust 注入两条路径分别验证保存亮色+系统深色、保存暗色+系统亮色、无记录+系统深色、未知字段+系统深色；检查快照前透明且正文/标题栏隐藏、首个可见背景/标题栏颜色、系统变化不覆盖，以及失败恢复读取最新快照。脚本 `/private/tmp/keepwork-startup-preference-smoke.cjs`，日志 `/private/tmp/keepwork-startup-preference-smoke.log`；亮色对照截图 `/private/tmp/keepwork-preference-rust-init-script-light-os-dark.png`。两套真实脚本的页面深浅切换、body CSS 变量、混合色与延迟皮肤另已回归通过，日志 `/private/tmp/keepwork-startup-page-colors-smoke.log`。
- `cargo build --offline --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，本地开发程序已重新编译，日志 `/private/tmp/keepwork-light-startup-build.log`；`git diff --check` 通过。

上述浏览器测试使用隔离状态夹具，Rust 持久化测试使用临时配置档；未访问真实账号、迁移网页设置或发布安装包。原生 macOS / Windows 整窗首帧尚未实机验收。四处版本同步 **0.2.80**，本轮规则取代下方 0.2.79 的“跟随系统”约定。

## 2026-11-13：启动画面与深色顶部栏（0.2.79）

正常启动显示居中品牌、加载提示和轻量进度动画，跟随系统深浅色并支持减少动态效果；连接失败后才显示恢复按钮，诊断默认折叠。保留同一 WebView、20 秒超时、5/15/30 秒退避重试和旧宿主手动重载。标题栏的 TypeScript 与 Rust 注入路径共用 `src/chromeTheme.js`，监听 document 非冒泡主题事件、原有 window 事件、样式表加载与主题属性变化，并在页面 CSS 上下文解析变量和混合颜色。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript 与前端构建通过；Rust **161 通过 / 1 实连默认忽略**，Node **329 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-startup-theme-check.log`。初次沙盒运行因禁止回环监听失败，允许隔离 HTTP/WebSocket 夹具监听后完整重跑通过。
- `node --test --test-reporter=dot apps/aichat-rust/tests/titlebar.test.cjs apps/aichat-rust/tests/page-connection.test.cjs apps/aichat-rust/tests/menuChrome.test.cjs`：**83/83**。覆盖两套标题栏、默认深色无 `.dark`、`body.light` 切换、非冒泡事件、延迟样式、系统偏好、重复同步去重，以及正常启动隐藏恢复入口、失败/重试状态、旧宿主、超时退避和防并发。
- Chrome 无头隔离页面验证两套实际脚本的可见颜色：深浅切换、body 局部 CSS 变量、`color-mix()` 和延迟皮肤加载均通过。加载构建后的入口验证明暗启动居中、640×480 无横向溢出、减少动态效果、失败后显示恢复操作、折叠详情及点击重试均通过。临时验证脚本 `/private/tmp/keepwork-chrome-browser-smoke.cjs`，日志 `/private/tmp/keepwork-chrome-browser-smoke.log`，截图 `/private/tmp/keepwork-startup-{light,dark}.png` 和 `/private/tmp/keepwork-recovery-{light,dark}.png`。未加载真实账号或连接线上聊天/MCP。
- `cargo build --offline --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，日志 `/private/tmp/keepwork-startup-theme-build.log`。四处产品版本同步 **0.2.79**，`git diff --check` 通过。

浏览器夹具不等同 macOS WKWebView / Windows WebView2 原生窗口实测；本轮未发布安装包，已编译本地开发程序，需重启客户端生效。

## 2026-11-12：已配对遥控器默认自动开启（0.2.76）

按照用户最新要求，`autoStart` 默认为 true；有效旧配置省略字段时同样开启，未知旧字段继续忽略，损坏配置则关闭自动开启、保留原文件并显示错误。启动及后台定时检测只使用系统已配对/已连接证据，唯一匹配才启动现有 BLE 会话；无设备时不主动扫描、不拦截 F5、不弹窗或抢焦点。多设备歧义、指定 ID 不匹配、配对证据不足及权限问题均给出明确状态，不任意选设备或反复弹出授权。

本轮验证重点：取消「配对后自动开启」须持久保存 false 并停止当前会话；重新勾选解除当前进程的停止/错误抑制并重新被动检测。手动停止仅抑制当前进程的自动恢复，重启按偏好执行；false 时仍可手动临时启动。覆盖之后配对/唤醒、候选变化、并发/迟到检测、开关写入失败和停止/退出竞态，确保关闭或 shutdown 后旧检测不能重新拉起。完全退出需终止 watcher 及会话，关闭设置窗口继续沿用后台运行行为。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript、前端构建通过；Rust **160 通过 / 1 实连默认忽略**，Node **293 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-remote-autostart-check.log`。
- 自动开启 Node 契约 **5/5**、隔离纯 Rust 策略 **9/9**；配置/生命周期集成验证默认值、旧格式、显式 false、损坏/不可读配置不覆盖、关闭持久化、手动停止仅本进程抑制，Stop/Off/手动启动/退出后的迟到配对结果均不能建立会话。无设备和探测失败路径不创建原生输入；关闭选项取消已有夹具会话并阻止迟到文字及发送口令。
- 配对候选选择 **6/6**，覆盖普通耳机/键盘、无配对、唯一设备、多设备、不同来源的同一设备合并、指定 ID 与证据不符、身份冲突及 MAC 不能冒充 CoreBluetooth UUID。macOS 原生探测文件编译通过；新增只读探测模块的 Windows x64、ARM64 独立 `cargo check --offline` 通过。独立编译使用隔离宿主，不等同完整 Windows 客户端实测。
- 自动检测最多一个在途任务，退出/偏好/手动操作会撤销旧探测；权限和其他探测错误暂停重试。蓝牙适配器关闭或尚未可用属于可恢复等待，不因该状态永久停用自动开启。设置轮询不覆盖之后发起的开关操作，也不抢焦点。
- 四处版本同步 **0.2.76**；`git diff --check` 通过。`cargo build --offline --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，macOS 开发程序构建日志 `/private/tmp/keepwork-remote-autostart-build.log`，需重启原生客户端生效。

真实 macOS/Windows 配对、权限和休眠唤醒仍需设备实测；本轮没有启动真实输入监听或向用户前台发送按键。macOS 对已保存的指定 CoreBluetooth UUID 若无法从系统配对记录验证对应关系，会明确暂停并提示手动启动或清空设备 ID；不会拿配对记录的 MAC 冒充 UUID。上述默认开启与停止规则替代下面历史版本中的默认关闭约定，语音、清除和发送契约沿用前轮记录。未发布安装包。

## 2026-11-12：遥控器清除、原生发送与操作引导（0.2.75）

本轮增加当前输入框清除和三张操作卡，设备/权限说明折叠显示，实时展示按键来源与可用状态。macOS 仅接收严格确认的小米 HID 设备 page `0x07` / usage `0xF1` 返回键，短按请求清除；这不是普通键盘 F1，不全局重映射 Enter/Escape/Menu，不写入设备 UserKeyMapping。多个候选 HID 来源无法消歧时禁用物理清除，语音输入及整句口令继续可用。Windows 不尝试电源键或返回键映射，以整句「清除提示词」提供清除入口。

OK 在两个平台上保持系统原生 Enter，客户端不拦截或额外注入。操作卡要求识别完成后再短按；不排队、不自动补发，不把原生 OK 的通过视为客户端已经确认目标应用提交。整句「发送提示词」继续使用上一轮一次系统 Enter 契约，目标应用自身的忙时/换行规则不变。

清除仅在当前焦点可编辑、非只读且修饰键已松开时执行 Cmd/Ctrl+A、Backspace，不读写剪贴板，不恢复历史选区，不聚焦其他窗口。角色/只读检查只用于清除，不重新阻止缺少 AX/UIA 选区元信息的普通口述。整句「清除提示词」沿用精确匹配规则：仅修剪首尾空白和末尾 `。．.!！?？`，不匹配引用、长句、内部空格或后缀。物理返回键可取消当前录音及在途 ASR，迟到结果不得输入；按住语音键期间取消后持续丢弃到松手，不发送 `MIC_CLOSE`。语音清除命令必须先完成其 ASR，不承诺即时取消正在识别的其他段落。

本轮验收要求：

- **来源与普通键盘**：单只确认设备的返回键触发清除；未知设备、不同 VID/PID/usage、普通键盘 F1/Escape/Enter/Menu、注入事件和多设备歧义不触发物理清除。重复按下、持续按住及重复报告不能多次清除；OK 原生事件继续通过，客户端额外 Enter 次数为零。停止、断连、设备移除和退出后监听释放，旧来源迟到事件无效。
- **跨 collection 释放屏障**：HID 来源集合发生变化后，仍按住的物理键必须先释放，再接受下一次全新按下—松开。此状态按同一物理设备共享，不能因 collection 重排、新枚举或局部 `downMask` 被重建而失效。覆盖“按住 → 同设备 collection 重排 → autorepeat down → up”，这一序列清除次数必须为零；只有所有仍按住的键释放后，新的完整短按才可触发一次。多 collection 交错、设备切换和旧回调迟到均不得把持续按住识别为新的清除操作。
- **清除行为**：受控可编辑输入框被全选后删除一次，当前既有选区不影响清空整个输入框；只读、非输入焦点、无法确认可编辑性及修饰键按下时不执行清除并准确提示。剪贴板读写、窗口激活和历史光标恢复为零；不能把整个页面、文件列表或其他非编辑区域作为清除目标。
- **录音/识别竞态**：物理返回键取消本轮录音/ASR并尝试清除，后续结果不重填、不发送；覆盖清除与 ASR 完成交错、仍按住语音键、重复清除、失败、停止/重启和 generation 变化。语音清除仅使用有效最终结果，重复/中间结果不执行，长句保持口述。取消不发送 `MIC_CLOSE`，下一次全新 PTT 仍能录制。
- **界面与开始输入**：操作卡区分语音、清除、发送，来源不可用或歧义时说明原因；设备与权限说明可展开，核心操作始终可见。「就绪，开始输入」由用户显式点击后隐藏设置并返回主窗口，不恢复历史外部应用或光标；后台输入期间不因状态更新抢焦点。普通口述、两条整句口令、云端失败和停止路径回归。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript、前端构建通过；Rust **144 通过 / 1 实连测试默认忽略**，Node **288 通过 / 4 平台跳过 / 0 失败**。最终日志 `/private/tmp/keepwork-remote-buttons-check.log`。本地 WebSocket 夹具需要回环监听，最终检查在允许该监听的环境执行。
- 最终完整检查中的 `remote_voice::` 专项 **43 通过 / 1 实连测试默认忽略**，包含取消录音后丢弃到松手、仅取消 pending ASR 不影响下一段、已 ready/未 ready 的文字及发送口令均随拥有的 future 失效、清除口令精确匹配和零剪贴板/零 Enter。
- 按键及原生输入 Node 隔离夹具 **6/6**：生产 HID 分类器拒绝未知来源/普通键、歧义和过期操作，覆盖重复报告、初始 held/未知状态、跨 collection 释放屏障以及重排后 autorepeat 不误清空。HID 夹具禁止创建真实 manager、检查输入授权或启动监听线程。生产清除函数在可编辑当前焦点只产生一次 Cmd+A、Backspace，只读/安全输入/非编辑区域不产生删除；普通口述和发送仍无需 AX 选区快照。
- Windows x64、ARM64 的独立原生模块 `cargo check --offline` 通过，包含 BLE/ASR/ATVV、系统输入及新增 UIA 可编辑性检查；应用外壳使用隔离 stub，此项不等于真实 Windows 蓝牙或界面已验收。
- 四处产品版本同步 **0.2.75**；`git diff --check` 通过。`cargo build --offline --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，macOS 开发程序构建日志 `/private/tmp/keepwork-remote-buttons-build.log`，需要重启原生客户端生效。

物理返回键接入与清空、OK 原生发送、权限及多设备状态仍需真实遥控器验证。RC003 的设备属性和返回键 HID element 在实际系统是否可见尚未实测；RC001 或 Windows 返回键不宣称支持，提供语音清除降级。受控 HID/输入夹具不等于真实遥控器到目标应用操作已通过，本轮未向用户前台发送或清除内容。用户此前已确认其设备上识别和复制成功，此证据不扩展为本轮物理清除已通过。保留旧版本验证记录，不把其旧目标快照或零 Enter 的普通口述结论套用于新动作。未发布安装包。

## 2026-11-12：遥控器「发送提示词」语音命令（0.2.74）

用户明确要求说「发送提示词」时帮助发送。该命令仅以整段最终 ASR 文字匹配：修剪首尾 Unicode 空白和末尾句末标点 `。．.!！?？` 后，必须精确等于 `发送提示词`。不删除引号、内部空白或内部标点，不使用 contains、后缀、同音或语义匹配。正文后附「发送提示词」仍为普通口述，不扩展为同段输入并发送。匹配后只向执行时当前前台键盘焦点发送一次 Enter，不粘贴命令字、不读取或修改剪贴板、不恢复旧焦点；普通口述保留当前光标粘贴且不按 Enter。此段补充下面 0.2.73 历史记录的普通口述契约，发送动作仅由精确命令触发。

本轮验收要求：

- **精确匹配**：`发送提示词`、带首尾空白或末尾 `。`、`！`、`?`、重复句末标点的结果触发一次 Enter。`请发送提示词`、`解释一下发送提示词是什么意思`、`正文，发送提示词`、`“发送提示词”`、`发送 提示词`、`发送，提示词`、同音词及重复命令组成的长句均正常口述，不触发发送。
- **动作与焦点**：匹配命令时 Enter 为一次，paste、剪贴板读写、窗口激活和光标恢复均为零；输入框已有内容保持原样交由目标应用处理。录音后切换应用或输入框时使用执行时的当前焦点。成功状态显示「已发送回车指令」，不声称提示词已经提交。目标应用按自身 Enter 规则处理；AIChat 当前普通聊天忙时 Enter 会停止生成，非忙时可发送，外部编辑器可能换行。客户端不检测网页忙碌状态、不引入网页发送协议，也不自动排队或补发第二次 Enter；应在受控应用夹具中区分这些结果，不把系统按键成功当成所有应用均已成功提交。
- **取消与失败**：只处理当前有效 generation 已完成的 ASR 结果；中间识别结果、旧轮迟到回调、停止、退出、空结果或 ASR 失败不发送。重复结果/完成通知不得重复执行 Enter。修饰键按下时不发送，提示「请松开修饰键」，不自动松开用户按键；系统权限或输入失败显示实际错误，结果不确定时不自动重试。
- **普通输入回归**：非命令口述仍向当前焦点粘贴一次、不发送 Enter；保留云端识别、默认关闭、忙时整段丢弃、网络失败不自动重传、停止取消和剪贴板错误处理。命令识别不引入网页或 MCP 注入接口。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript、前端构建、Rust **134 通过 / 1 实连测试默认忽略**、Node **284 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-voice-send-command-check.log`。
- 原生输入专项 Rust **16/16**、Node **6/6**，覆盖精确匹配标点矩阵、普通长句与引号不触发、命令零剪贴板/零粘贴且只发送一次、停止/修饰键保护和不确定失败不重试。两个真实本地 WebSocket 到 ASR 最终结果再到假输入后端的集成夹具，分别验证临时口令变为最终长句时零发送，以及最终口令一次发送；独立的下一段同名口令仍可执行，不按文字全局去重。
- macOS 生产函数经完全隔离的剪贴板与键盘事件夹具验证：普通口述为 Cmd+V，命令为 Return 键码 36 的按下/释放且修饰标志为零，输入框草稿和剪贴板不被命令文字改写。Windows x64、ARM64 原生输入模块独立编译检查通过。未向用户前台发送真实 Enter 或外部消息。
- 四处版本同步 **0.2.74**；`cargo build --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，已生成新 macOS 开发程序，需重启原生客户端生效。日志 `/private/tmp/keepwork-voice-send-command-build.log`。

尚未将真实遥控器说出命令后发送 AIChat 提示词计为通过；上一轮用户已确认识别和复制成功，不代表本轮语音发送已实测。按键夹具不验证目标应用实际提交、AIChat 忙闲状态或服务器接收，不把一次 Return 送出当成所有应用均已发送消息。未发布安装包。

## 2026-11-12：遥控器识别文字直接输入当前焦点（0.2.73）

用户已反馈真机语音识别成功，并提供状态截图，显示文字已经复制但要求手动粘贴。本轮据此修复正常输入框被降为仅复制的问题：旧实现要求录音开始时的窗口、控件和选区快照与输入前完全相同，而 WebView 可能不提供 AX/UIA 文本选区，光标移动也会改变快照。本轮移除这项输入前置条件，识别完成时向当前前台应用的键盘焦点直接发送一次系统粘贴。下面历史 0.2.71 记录中的起始目标绑定、AX 选区校验及目标变化后仅复制，描述的是当时实现，不再适用于本轮输入行为。

使用时先点击目标输入框；录音或识别期间移动光标、更换输入框或切换应用，以完成时的当前位置为准。不恢复旧窗口或光标，不激活应用，不按 Enter，不自动发送聊天消息。缺少可访问性控件/选区元信息不会阻止普通系统粘贴。修饰键仍按下时不执行输入，提示「请松开修饰键」，不能误报光标或前台应用已变化。停止、退出和旧 generation 继续取消迟到结果，不改变 ATVV、Keepwork ASR、默认关闭及忙时丢弃新录音的契约。

本轮验收要求：

- **输入行为**：在 HTML textarea、contenteditable 和外部编辑器中接收一次系统粘贴，覆盖没有 AXSelectedTextRange/UIA TextPattern 的输入框。录音后移动光标、更换输入框或切换应用时文字进入完成时的位置；当前选区由目标应用正常替换，原窗口和光标不被恢复。
- **取消与按键**：停止、退出、旧 generation、空/无效文字及 ASR 失败不写入剪贴板、不发送输入；成功路径至多一次粘贴且不发送 Enter。按住 Ctrl、Alt、Shift、Command 或 Windows 等修饰键时不输入，错误原因准确，不自动释放用户按键或重复发送。
- **范围与错误**：AIChat 与其他应用采用相同的当前焦点语义，不强制切回聊天输入框。剪贴板写入、系统权限或按键发送失败显示实际错误。输入发送成功不能单独证明所有目标应用都已接收文字，需以真实输入框内容验收。

已执行验证：

- `pnpm --prefix apps/aichat-rust check`：TypeScript、前端构建、Rust **126 通过 / 1 实连测试默认忽略**、Node **284 通过 / 4 平台跳过 / 0 失败**。日志 `/private/tmp/keepwork-remote-voice-direct-input-check.log`。
- 新增 Rust 输入交付回归 **8/8**，覆盖没有目标快照时当前焦点输入、修饰键、空/无效文字、复制期间停止、迟到调用和不确定失败不重试；停止 generation 的主链测试继续通过。
- `node --test apps/aichat-rust/tests/remote-voice-native-input.test.cjs`：**2/2**，真实 macOS 原生复制/粘贴函数在隔离的剪贴板和键盘事件边界下，向当前受控输入框的光标插入一次中文，旧输入框不变，AX 查询为零且不发送 Enter。没有访问真实系统剪贴板或向用户前台发送按键；该夹具不是实际 WebView/真实桌面端到端测试。
- Windows x64、ARM64：新 BLE/ATVV/ASR/原生输入模块及测试的隔离集成 `cargo check --offline --tests --target <target>` 均通过；去除不再使用的直接 UIAutomation 依赖，异步任务继续满足 `Send`。临时宿主夹具 `/private/tmp/keepwork-native-remote-voice-check`，不是 Windows 链接打包或真实键入测试。
- 四处版本同步 **0.2.73**；`cargo build --manifest-path apps/aichat-rust/src-tauri/Cargo.toml --bin Keepwork` 通过，已生成新 macOS 开发可执行程序，需重启原生客户端进程生效。日志 `/private/tmp/keepwork-remote-voice-direct-input-build.log`。

用户反馈可作为其设备上识别和复制已经成功的证据，我们未亲自执行完整真机链路，也尚未将修复后的真实遥控器到输入框直接输入计为通过。还需在 macOS 和 Windows 的实际 AIChat 输入框及外部编辑器验证输入、焦点切换和修饰键行为。既有协议、静音实连及历史 AX 夹具结果不能替代这些验证；未发布安装包。

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

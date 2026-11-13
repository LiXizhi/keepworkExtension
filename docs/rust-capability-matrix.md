# Rust 产品当前能力与验收矩阵

本页是 `aichat-rust`、`mcp-rust` 与 Node/Electron 参考实现的**当前范围索引**。能力含义以实现、显式能力字段和契约测试为准；版本号不用于判断对端是否支持。更新功能范围时同时更新此页，其他 README 与迁移文档链接到本页，不各自维护相反的“已完成/待移植”表。

“已实现”只说明源码提供该契约。“已有夹具/原生记录”指仓库已有的验证记录，不表示本次审阅重新执行，也不代表当前安装包、真实账号、所有平台组合均通过。历史版本的验证继续保留在各产品 `VALIDATION.md` 与 [历史迁移记录](history/rust-runtime-migration-20261113.md)，不能用其阶段状态覆盖本页。

## MCP 引擎范围

Node 列表示共享 Node MCP 的参考行为，不承诺每台机器的外部 CLI、账号或操作系统都支持。Rust 列的平台通常为 macOS/Windows；Linux 的源码路径不等于已经交付 Linux 桌面安装包。

| 能力 / 协商入口 | Node MCP | Rust MCP 当前范围 | 平台与验证边界 / 回归入口 |
| --- | --- | --- | --- |
| 回环单例、MCP JSON/SSE、Origin/可选 Bearer | 已实现 | 已实现；同一协议身份与旧请求默认值 | 双引擎隔离契约：`scripts/contract/{health,mcp-handshake,cors-auth}.test.cjs`；不放宽安全规则 |
| 文件/文件夹浏览/PTY：`fsApi`、`folderBrowserApi`、`terminalApi` | 已实现 | 已实现；保留路径、链接、文件上限、PTY UTF-16 游标语义 | `scripts/contract/{fs,terminal}.test.cjs`；Windows 原生 PTY与安装包仍按目标平台验收 |
| 五个可移植 MCP 工具 | 已实现 | `run_terminal`、`grep_files`、`mcp_status`、`web_search`、`fetch_url` 已实现 | `scripts/contract/tools.test.cjs`；Rust `fetch_url` 使用静态获取，无 Node 的浏览器渲染 pass |
| Dashboard、`/admin/history`、`/admin/api-docs` | 已实现 | 已实现；目录只列 Rust 实际路由/工具，缺项不可假装全量对齐 | `src/http/mod.rs`、`src/dashboard.rs`（相对 `apps/mcp-rust/crates/keepwork-mcp/`）；`apps/mcp-rust/scripts/dashboard-personas.test.cjs` |
| Presence / persona 变更流 | 已实现 | 已实现，保持 Origin+owner 隔离、登录只在内存 | `scripts/contract/{presence,personas}.test.cjs`；真实登录另验 |
| 原生 CLI 会话：`agentSessionApi` / `agentContextApi` / `agentModeApi` | 已实现 | Codex app-server、Claude stream-json、Antigravity `agy`、登记的 ACP 适配已实现；Copilot ACP 不提供所需每会话网页 MCP 绑定，显式请求该语义时拒绝 | `scripts/contract/agents*.test.cjs`、`antigravity.test.cjs`、`deepseek-models.test.cjs`；历史 macOS WorkBuddy/Claude 实测不代表 Windows/所有 provider 通过 |
| CLI 图片轮次：`agentImageTurnApi: v1` | 按 provider 支持 | 已实现；Codex/Claude 原生图片块，ACP 必须握手声明图片；Antigravity 明确拒绝 | `scripts/contract/agents-images.test.cjs`；发现模型或CLI不代表真实图片推理通过 |
| CLI 原生历史导入 | 按 provider 支持 | Codex 原生历史列表/读取/显式继续已实现；其他 provider 的原生历史目录导入未提供。已登记会话恢复是另一能力 | `scripts/contract/agents-codex.test.cjs`；读取历史不发送 prompt，外部 busy 线程不可被抢占 |
| 账户切换 / Copilot 编辑器自定义模型 | Node 专有路径 | 未移植；不自动换 provider 或引擎 | 维持局部不可用提示，普通聊天仍可用 |
| 后台本地空间文件工具 | 已实现 | 明确授权的本机空间；修改仅 Craft。云端/Git 文件仍需原网页在线工具；Git 草稿 import/get/drop/ack 可持久保留，远端校验/后台 Git 编辑/受保护 deck 暂存未实现 | `scripts/contract/agents.test.cjs`；未知结果不重放，未校验 remote base 不报告成功 |
| Persona 对话 / isolated context | 已实现 | Keepwork 执行器、文字流、requestId 幂等、取消、持久历史、`taskContextVersion: 1` 已实现；原生 CLI persona 执行器未移植 | `scripts/contract/personas.test.cjs`；执行次数取真实元数据，缺失表示未知 |
| Persona 本地工具 | 已实现 | `grep_files`、`web_search`、`fetch_url`，以及仅单条 `dws` / `lark-cli` 的 `run_terminal`；不提供任意 Shell/文件写入能力 | `src/personas/local_tools.rs`、`src/personas/model.rs`；Keepwork `localTools` 与完整参数快照，最多 8 轮工具 |
| 钉钉 / 飞书渠道与收件箱：`messagingApi` | 已实现 | 已实现绑定、监听/轮询、去重、预算、Keepwork 自动文字回答、人工回复；原生 CLI / 无头 worker 执行器未移植 | `scripts/contract/messaging-channels.test.cjs`；真实发送与账号验证必须另记，不以 fixture 回执代替 |
| 钉钉历史刷新 / 图片附件 | 可选 `inboxRefreshVersion` / `replyImage` | 显式有界历史刷新、钉钉 file 图片附件已实现；飞书与缺少能力的旧端保留文字回复 | `src/messaging/refresh.rs`、`image_reply.rs`；未知发送结果禁止重放；不声称完整历史已恢复 |
| Circles | 已实现 | owner 主动 read/preview/apply、组织/成员/角色、渠道部署、冲突与回执已实现 | `tests/{circles_contract,circles_channels_contract}.rs`；夹具不代表真实钉钉/飞书写入已验收 |
| 群昵称同步、自动多分身群路由、多电脑协调、微信、自主销售 | Node 的对应独立功能 | 未移植完整执行语义；不从通用 `messagingApi` 或兼容字段推断支持 | 对应设置/动作说明边界；不把未实现的执行结果当空成功 |
| 浏览器/电脑操作/Paracraft 服务 | 已有独立能力 | 未全面移植；不声明 `browserApi` 等未实现合同 | 仅对已声明能力显示操作；不能因默认 Rust 缺项而静默改用 Node |

## 桌面宿主与平台

| 能力 | Electron 参考 | Rust Tauri / WebView2 | Windows CEF 兼容宿主 | 已有验证与仍需验收 |
| --- | --- | --- | --- | --- |
| Bridge v1 文件、PTY、默认大脑、Git、菜单/主题、托盘/桌宠 | 已实现 | 已实现共享合同；可选新增能力分别协商 | 不注入 Bridge、不托管 MCP，不宣称桌宠/终端/本地文件 | Rust 契约与原生模块回归；每个平台的真实整窗操作仍按清单验收 |
| 网页唤起 / 首次引导 `launchIntents: true` | 已实现 | 可选合同、冷/热启动与确认消费已提供，实际验证结果见回执 | 首版不提供桌面 Bridge；不要把 CEF 可加载网页当作首次引导已实现 | `open` 只唤回；`onboarding` 可恢复向导；旧网页可忽略新能力。系统注册需最终包真机验收 |
| MCP 更新 | 独立 Node v1 feed | Rust 独立 v2 feed，Node 显式兼容构建保留 v1；不允许更新清单混引擎 | 不托管 MCP | 暂存、身份校验、外部 owner、失败回滚需隔离回归；真实更新/降级仍需最终包回执。本地归档/清单不代表CDN已发布 |
| 桌面安装包自更新 | 已实现 | 已实现；下载摘要、离线 stale 缓存、显式确认安装 | 独立兼容 feed，不替换外层启动器 | 包存在/CDN校验不代表安装、系统提示或数据恢复通过 |
| 原生网页浏览 surface / 固定视口 / 等比缩放 | iframe 路径 | 仅 macOS 声明三项 `browserSurface*Version`；Windows/Linux 仍走能力降级 | 原有普通子框架导航 | macOS 隔离 WKWebView 与实际输入记录；未声称 Windows 原生 surface 已完成 |
| HTTPS 页面访问本机 MCP | 浏览器引擎路径 | macOS 受限原生 fetch 通道；可信顶层+精确8089+真实 Origin，保留 auth/owner，不自动重发 | 网页自身连接能力 | 真实 WKWebView 隔离夹具覆盖 SSE/NDJSON/Abort；真实登录整窗仍需验收 |
| 宠物后台听写 / 通话采集 | 原路径 | 可选音频租约协商；macOS 有原生可见性/播音记录，首次系统授权照常出现 | 无 | 模拟音轨不等于真人麦克风和云端 ASR；混合DPI、失焦、睡眠/唤醒另验 |
| 小米遥控器输入/清除/发送 | 无对应原生模块 | macOS/Windows 原生实现；Windows 物理返回键不映射，保留语音清除；Linux 不支持 | 无 | 协议、WebSocket、原生输入隔离夹具；真实设备/权限/目标应用提交必须独立回执 |
| Windows 无 WebView2 兼容启动 | Electron 独立产品路径 | 常规安装保持 Tauri/WebView2 | 预览：云端聊天/登录，下载校验缓存；不承诺与正常桌面等价 | [CEF 边界](../apps/aichat-rust/docs/windows-cef.md)；Windows/Win7真实安装与账号测试未由源码检查证明 |

## 验收状态与维护

证据按 `source`（静态/编译）、`fixture`（隔离协议/浏览器）、`native`（真实原生模块/窗口）、`packaged`（最终安装包）、`live`（真实账号/硬件/业务）分别记录。某一层通过不能提升另一层；未执行为 `pending`，环境阻止为 `blocked`，失败为 `failed`，明确不适用才为 `skipped` 并注明理由。

每次交付生成 [结构化回执](acceptance/rust-release-evidence.schema.json)，执行 [Rust 安装包发布验收](acceptance/rust-desktop-release.md)。本页不把正在工作的共享8089服务、已安装桌面或线上网页自动视为本仓最新版本。能力改变时同步更新矩阵、声明字段、可选能力缺失/未知/断线/降级与新旧组合测试，再把实际命令与产物写入回执。

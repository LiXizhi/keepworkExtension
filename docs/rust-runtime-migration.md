# Keepwork MCP: Node → Rust 迁移契约

本文件是 `apps/mcp-rust`（Rust 守护进程）与现有 Node 守护进程（`apps/mcp-runtime`）之间的迁移契约。`aichat-rust` 默认选择 Rust MCP；`aichat-desktop`、`vscode-extension`、`local-helper` 在 P4 之前继续可以只发 Node 运行时。两条发行线路独立，缺少可选能力不能触发隐式引擎切换。

## 1. 不变的外部契约

| 项 | 值 |
| --- | --- |
| 监听 | `127.0.0.1:8089`（`KEEPWORK_MCP_PORT` / `--port` / `config.json` 同优先级） |
| `/health.name` | `keepwork-mcp`（客户端靠它识别） |
| `/health.version` | `0.1.2`（服务协议版本，不是 app 版本） |
| `/mcp` | Streamable HTTP：`initialize`、`nextCursor` 分页、`Mcp-Session-Id`、GET SSE、重复 GET `409`、`keepwork/streamedResponses` v1 协商 |
| CORS/鉴权 | 允许 `keepwork.com`、`*.keepwork.com`、`localhost`、`127.0.0.1`；`/mcp`、`/admin/*`、`/fs/locations|browse`、`/terminal/*`、`/agents/*`、`/messaging/*`、`/model-studio/*` 受 `requireAuth` 保护，`/health`、`/exists`、`/fs/*` 不保护（与 Node 一致） |
| 工作区 | `--root` > `KEEPWORK_MCP_ROOT` > `config.json.workspaceRoot` > `~/.keepwork-mcp/workspace`，并确保 `default/` 槽位 |
| 令牌 | `~/.keepwork-mcp/token`，24 字节 hex，0600 |
| 单实例文件 | `~/.keepwork-mcp/instance.json` `{pid,port,startedAt,name}` |

`/health` 只声明已经实现的能力：当前返回 `requireAuth`、`workspaceRoot`、`fsApi`(`workspace`)、`folderBrowserApi`(`folders-v1`)、`terminalApi`(`pty-session-v1`)、`aichatPresenceApi`(`post-sse-v1`)、`personasApi`(`personas-v1`)、`messagingApi`(`messaging-v1`)、`runtimeEngine`、`runtimeProduct`。`agentSessionApi`、`browserApi` 等未实现能力不出现；缺少可选字段表示不可用或未知，不能推断整个连接损坏，也不能要求客户端与服务端产品版本相同。

### 分身文字问答边界（Rust 运行时 0.2.4）

`/agents/personas` 已提供分身配置、历史记录、发送、已读、清空、取消与变更事件，支持桌面宠物通过现有 Bridge v1 向“我的分身”发送文字。AIChat 仍需连接本机服务并绑定本机第二大脑目录；不能把不可用的分身消息自动改投普通聊天。该切片不表示完整 P2 已完成。

- **身份与权限**：要求显式允许的 `Origin` 和 `X-Agent-Owner`，开启守护进程鉴权时继续校验令牌。分身记录沿用 Node 的 `~/.keepwork-mcp/personas-v1` 格式；模型请求只使用同一 owner 的 AIChat presence 登录，不能退到其他账号。登录 token 只保留在内存。
- **实际执行**：使用真实 HTTPS Keepwork `/core/v0/gpt/chat` 请求生成文字答复，当前实际执行器是 Keepwork，不是原生 CLI。上下文可包含有界会话历史及限于所选目录内的 `AGENTS.md`；尚无工作区工具或通用第二大脑文件检索。返回的执行元数据为工具请求 `0`、工具返回 `0`，不能据答复文字宣称业务操作已执行。
- **任务上下文**：`taskContextVersion: 1` 表示实现 `contextMode: "isolated"`，不携带旧会话历史或摘要；省略该参数仍按原有会话模式处理。
- **草稿与幂等**：用户文字和 requestId 落盘成功后才接受发送；写入失败不得启动模型请求。相同 requestId 不重复提交；服务重启后的未完成任务标记结果未知，不自动重放。客户端遇到不确定结果应先核查原请求，不能换 ID 自动重发。宠物在未就绪时可保留本地草稿，但不能假装发送成功或跨 context 搬运草稿。
- **未提供的能力**：分身协作、文件写入、钉钉/飞书/微信消息、自主销售和原生 CLI 执行尚未实现。不声明对应可选能力，不把明确动作请求降为普通模型答复；操作边界返回 `UNSUPPORTED_FEATURE`，普通文字问答继续可用。

### 分身消息托管边界（Rust 运行时 0.2.5）

Rust 运行时 0.2.5 起托管钉钉/飞书消息渠道，`/health` 声明 `messagingApi: "messaging-v1"`，AIChat 的“连接设置”在 Rust 引擎下可用。

- **已提供**：绑定生命周期（`channel-connect` / `channel-login` / `bind` / `channel-start` / `channel-stop`）、渠道占用与显式 `switchFromRoot` 切换（409 `CHANNEL_OCCUPIED`）、钉钉 `dws` ndjson 事件监听（5 分钟重连）与飞书 `lark-cli` 单页轮询（10 分钟间隔、游标检查点）、去重/触发判定/每小时回复预算、inbox 视图与动作、手动回复、Keepwork 模型自动回答、`~/.keepwork-mcp/messaging-v1` 持久化布局（`bindings.json`、`<id>.json`、`inbox.json`、`channel-roots.json`、`<id>.cursor.json`），以及 `/messaging/*` 管理面（config / profiles / groups / status / start / stop / events SSE）。
- **仍为 Node 独有**（Rust 侧保持 `UNSUPPORTED_FEATURE`）：无头 worker 页（`/messaging/worker` 返回 422）、agent CLI 执行器、多电脑协调、群昵称同步、Circles、钉钉历史补收、多分身群路由、微信。
- **登记的差异**（断言落在 `scripts/contract/messaging-channels.test.cjs`）：knowledge 目录缺失统一报 `Knowledge directory missing`（Node 报原始 ENOENT 文案）；executor 校验放宽（接受 `keepwork`，缺省 `auto`）；`defaults` 与 `config.json` 解析失败时保留默认值；钉钉绑定始终输出 `channel` 字段；profiles 输出去重。回复执行器固定走 Keepwork 客户端路径。

### 分身本地工具与 CLI PATH（Rust 运行时 0.2.6）

Rust 运行时 0.2.5 给分身模型接入了本地工具，0.2.6 修复由此引入的两处协议回归，并要求 GUI 启动的守护进程能找到 `dws`：

- **工具定义字段**：Keepwork `/gpt/chat` 用 `localTools` 接收工具定义（同 `src/core/aichatRuntime.ts`）。0.2.5 误发 `tools`，模型收不到 `run_terminal`，执行元数据固定为工具请求 `0`、工具返回 `0`。
- **工具调用快照**：服务端先流式发送 `delta.tool_calls` 片段，再在 `data: {...,"tool_calls":[...]}` 中给出完整参数。Rust 只在完整快照上执行工具；只有增量片段而没有快照时按失败处理，不执行拼接不完整的命令。
- **CLI PATH**：桌面/`launchd` 启动的守护进程继承最小 `PATH`，而 `dws` 是 `#!/usr/bin/env node` 脚本，需要 Node 在 `PATH` 上。`dws`/`lark-cli` 一次性调用、`auth login`、事件监听子进程和 `run_terminal` 现在都注入 Node/CLI 安装前缀；`run_terminal` 仍让调用方 `PATH` 优先，Windows 使用 `Path`。

## 2. 运行时清单 v2（新增，v1 不动）

```json
{
  "schemaVersion": 2,
  "product": "keepwork-mcp-runtime",
  "engine": "rust",
  "version": "0.1.0",
  "commit": "<40 hex>",
  "platform": "macos",
  "arch": "arm64",
  "entry": "bin/keepwork-mcp",
  "args": ["--port", "8089"],
  "env": { "KEEPWORK_MCP_HOST_KIND": "standalone" },
  "health": { "url": "http://127.0.0.1:8089/health", "match": { "name": "keepwork-mcp" } }
}
```

- 压缩包布局：`runtime.json`、`LICENSE`、`bin/keepwork-mcp[.exe]`（0755）、`skills/`、`pet-companion/`。没有 `app/`、没有 `node_modules`。
- 新客户端必须接受 `schemaVersion ∈ {1,2}` 与两个 product；老客户端只读 v1 地址，看不到 v2。
- 分发走独立线路，互不影响：`mcp-runtime-rs/<target>.zip|json`、`mcp-stable-rs/<version>/`。

## 3. 宿主选择与接管

迁移的历史目标顺序是：**自带 Rust → 下载 Rust → 自带 Node → 下载 Node**，
不代表当前所有宿主已经实现该选择链。`aichat-rust` 的标准开发和打包入口
默认选择 `apps/mcp-rust`：`bundle:mcp` 与 `make:mac` / `make:win:x64` /
`make:win:arm64` 均使用 Rust。Node 仅保留显式 `bundle:mcp-node`、
`make:mcp-node:mac` / `make:mcp-node:win:x64`。`pnpm build` 只构建前端，
不隐式准备 Node 运行时。启动时校验实际捆绑
目录的引擎与清单；捆绑 Rust 时关闭 Node feed 热更新。Rust 准备失败或缺少
可选能力时明确报错或在功能边界降级，不自动改用 Node。

- 接管分两种情况：已识别为桌面管理的 MCP 服务（`rust-node-runtime` / `tauri-node-runtime` / `electron-node-runtime` / `desktop`）可按本次候选切换引擎，不跨引擎比较版本；同引擎则只有候选 `runtimeVersion` 严格更新时才接管。外部 VS Code / Local Helper 或其他宿主管理的服务不会仅因引擎不同被替换，同引擎的较新版本接管规则保持不变。
- 接管须满足 MCP 身份、有效 PID 和 Rust 启动重试状态检查；停止前重新探测并核对 PID。Unix 使用 `SIGTERM`，Windows 使用定向 `taskkill /PID <pid> /T /F`，随后最多执行 25 轮健康探测、每轮间隔 80ms，等待原服务退出。
- `KEEPWORK_MCP_HOST_KIND` 取值不变（`standalone` / `vscode-extension` / `local-helper` / `electron-node-runtime` / `rust-node-runtime`）；`/health.runtimeEngine` 表示实际引擎。当前宿主没有实现 `KEEPWORK_MCP_ENGINE` 环境变量选择，不能把设置该变量作为修复方法。
- 迁移顺序：`aichat-rust` → `aichat-desktop` → `vscode-extension` → `local-helper`。

### 当前可用的桌面运行时选择

日常开发入口 `pnpm tauri dev` 与 VS Code 的 `keepwork Rust Desktop: Start` 默认构建并使用 `apps/mcp-rust`，`pnpm dev:rust` 保留为同一 Rust 选择的显式别名。默认入口需要 Rust/Cargo 与桌面开发依赖；Rust 构建或校验失败时中止，不静默回退 Node。

`pnpm dev:node`、启动器 `--mcp-node` 或 `AICHAT_MCP_ENGINE=node` 才显式选择 `apps/mcp-runtime`。Node 路线使用 Node.js 22 或更新版本，从当前源码和本机已安装依赖生成独立开发运行时；缺依赖或编译失败会中止，不自动安装依赖。`AICHAT_MCP_ENGINE=rust` 继续接受。显式 `AICHAT_MCP_BUNDLED_DIR` / `AICHAT_MCP_RUNTIME_DIR` 优先，但必须通过所选引擎的清单与入口校验，不能在默认 Rust 入口中混入 Node。`AICHAT_MCP_ENGINE` 属于开发启动器，不是此前未实现的 `KEEPWORK_MCP_ENGINE`，也不会动态切换当前监听服务。

Rust MCP 当前仍缺少原生 CLI 会话接口；用户选择 Rust 后，CLI 连接器应按能力缺失明确提示，不自动改用 Node 或改变请求执行语义。修改默认配置不会停止当前监听服务，新选择在下次桌面进程启动时读取。开发入口选择不改变既有共享服务的所有权、接管和能力协商规则；运行中的 8089 服务仍须单独核验。

桌面开发页面固定绑定 `127.0.0.1:1430`。重复启动只复用身份协议、真实 checkout 目录均匹配的 Vite 服务；未知服务占用时明确失败，不终止该进程或自动更换端口。关闭复用启动不关闭原终端拥有的服务。这解决开发服务重复启动冲突，不会补齐 Rust MCP 的功能。

`aichat-rust` 已实现 `AICHAT_MCP_BUNDLED_DIR`：它指向包含 `runtime.json` 的
单架构运行时目录，**仅在下一次桌面进程启动时读取**，不会修改当前监听服务。
选择前必须验证清单 product、版本、平台/架构和 entry，以及 Node 二进制与
`app/cli.cjs`（Node runtime）或原生 entry（Rust runtime）的完整性；不能仅改
目录名或凭版本号判断引擎能力。Node 可复用
`apps/mcp-runtime/staging/<platform>-<arch>` 与
`apps/aichat-rust/scripts/bundle-mcp-runtime.cjs` 的验证/打包流程。

2026-11-11 排查确认：Rust `0.2.11` 不声明 `agentSessionApi`，原生 CLI
连接器的 `/agents/backends` 返回 404；Node 源码运行时的隔离实测结果不适用
于仍在运行的 Rust listener。使用 CLI 时需显式选择已验证提供该能力的 Node 兼容运行时，
不能把这一例外改成 `aichat-rust` 的默认引擎。切换前检查共享服务的所有者、活跃客户端和任务，
完成受控重启后重新读取实际端口的 `/health` 与目标 `/agents/backends`；
不得把重装 CLI 或反复重连当作补齐服务端实现。

以下为 2026-11-11 CLI 排查的历史记录，不是当前默认选择：当次经用户确认后切换到 Node `0.1.52`。切换中发现 stage 清单缺少 `commit`，
JS 打包验证能从同目录 `app/package.json` 读取，Rust 宿主却要求清单本身包含
该字段；使用同份产物的真实 commit 补全生成清单后，8089 恢复并声明
`agentSessionApi: "v1"`。stage/bundle/package 的永久修复已完成，跨宿主相关
Node 30 项、Rust 12 项测试通过。实际 8089 上 WorkBuddy、Codex 两轮实测均
通过；真实浏览器使用桌面相同源码服务与 8089 完成 WorkBuddy 选模型、发送和
接收回复，未驱动原生 Tauri 窗口。源码版本为 MCP/扩展 `0.1.53`、Rust 桌面
`0.2.45`；当次保留运行中的 `0.1.52`，避免再次中断用户会话。2026-11-12 用户重新明确要求 `aichat-rust` 默认运行 `apps/mcp-rust`，该要求覆盖此前把 Node 设为日常默认入口的选择。

## 4. 阶段门槛

| 阶段 | 门槛 |
| --- | --- |
| P0 | `/health`、MCP 握手、CORS/401/403 与 Node 一致；`mcp_status` schema 逐字节相同；release 二进制 macOS ≤10MB、Windows ≤12MB —— **已完成** |
| P1 | 本机面路由差分全绿；PTY 游标（CJK/emoji/半截转义）与 Node 一致 —— **已完成**：`scripts/contract/{fs,terminal,tools}.test.cjs` 双引擎对拍，游标按 UTF-16 码元计数 |
| P2 | 5 个 SSE 端点帧序/重连一致；agent CLI 冒烟 mac+win —— **部分实现**：presence JSON/SSE、基础分身文字问答与钉钉/飞书消息渠道托管已提供；agents/ACP、分身工具执行、无头 worker、多电脑协调仍待完成 |
| P3 | 105 条路由与 13 个工具 schema 全部对齐 |
| P4 | 三平台安装/首启/升级/降级/双引擎/owner kill/卸载通过 |
| P5 | 冻结 v1 feed，发行物不再引用 `app/cli.cjs` |

## 5. 对拍与回滚

- `scripts/contract/*.test.cjs` 用同一套断言分别打 Rust 二进制与 Node 守护进程（不同端口、隔离 HOME）。
- `scripts/contract/harness.cjs` 是唯一启动入口；新增路由时两边必须同时加断言。
- 任一阶段出现回归：先准备并验证需要回退的运行时。`aichat-rust` 可在下一次启动时使用上述 `AICHAT_MCP_BUNDLED_DIR`，其他宿主按各自已实现的打包/启动流程处理；当前没有通用的 `KEEPWORK_MCP_ENGINE=node` 开关。Rust 线可单独回滚版本，不影响 v1 feed。切换共享进程不应自动发生在只读诊断期间。
- 差异必须显式登记在测试里（例如 P1 的 `tools/list` 只列 5 个可移植工具、`/admin/status` 无 `nodeVersion`、`fetch_url` 无 headless 渲染），不允许“看起来一样”。

# Keepwork MCP: Node → Rust 迁移契约

本文件是 `apps/mcp-rust`（Rust 守护进程）与现有 Node 守护进程（`apps/mcp-runtime`）之间的迁移契约。四宿主（`aichat-rust`、`aichat-desktop`、`vscode-extension`、`local-helper`）在 P4 之前继续可以只发 Node 运行时。

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

`/health` 只声明已经实现的能力：当前返回 `requireAuth`、`workspaceRoot`、`fsApi`(`workspace`)、`folderBrowserApi`(`folders-v1`)、`terminalApi`(`pty-session-v1`)、`aichatPresenceApi`(`post-sse-v1`)、`personasApi`(`personas-v1`)、`runtimeEngine`、`runtimeProduct`。`agentSessionApi`、`browserApi`、`messagingApi` 等未实现能力不出现；缺少可选字段表示不可用或未知，不能推断整个连接损坏，也不能要求客户端与服务端产品版本相同。

### 分身文字问答边界（Rust 运行时 0.2.4）

`/agents/personas` 已提供分身配置、历史记录、发送、已读、清空、取消与变更事件，支持桌面宠物通过现有 Bridge v1 向“我的分身”发送文字。AIChat 仍需连接本机服务并绑定本机第二大脑目录；不能把不可用的分身消息自动改投普通聊天。该切片不表示完整 P2 已完成。

- **身份与权限**：要求显式允许的 `Origin` 和 `X-Agent-Owner`，开启守护进程鉴权时继续校验令牌。分身记录沿用 Node 的 `~/.keepwork-mcp/personas-v1` 格式；模型请求只使用同一 owner 的 AIChat presence 登录，不能退到其他账号。登录 token 只保留在内存。
- **实际执行**：使用真实 HTTPS Keepwork `/core/v0/gpt/chat` 请求生成文字答复，当前实际执行器是 Keepwork，不是原生 CLI。上下文可包含有界会话历史及限于所选目录内的 `AGENTS.md`；尚无工作区工具或通用第二大脑文件检索。返回的执行元数据为工具请求 `0`、工具返回 `0`，不能据答复文字宣称业务操作已执行。
- **任务上下文**：`taskContextVersion: 1` 表示实现 `contextMode: "isolated"`，不携带旧会话历史或摘要；省略该参数仍按原有会话模式处理。
- **草稿与幂等**：用户文字和 requestId 落盘成功后才接受发送；写入失败不得启动模型请求。相同 requestId 不重复提交；服务重启后的未完成任务标记结果未知，不自动重放。客户端遇到不确定结果应先核查原请求，不能换 ID 自动重发。宠物在未就绪时可保留本地草稿，但不能假装发送成功或跨 context 搬运草稿。
- **未提供的能力**：分身协作、文件写入、钉钉/飞书/微信消息、自主销售和原生 CLI 执行尚未实现。不声明对应可选能力，不把明确动作请求降为普通模型答复；操作边界返回 `UNSUPPORTED_FEATURE`，普通文字问答继续可用。

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

所有宿主统一顺序：**自带 Rust → 下载 Rust → 自带 Node → 下载 Node**。

- 只有当候选 `runtimeVersion` 严格更新时才接管（`SIGKILL` 旧 PID 后 40×250ms 等待），版本相同不换引擎，避免 Node/Rust 互相踢进程。
- `KEEPWORK_MCP_HOST_KIND` 取值不变（`standalone` / `vscode-extension` / `local-helper` / `electron-node-runtime` / `rust-node-runtime`）；新增 `KEEPWORK_MCP_ENGINE` 与 `/health.runtimeEngine` 供面板与排障使用。
- 迁移顺序：`aichat-rust` → `aichat-desktop` → `vscode-extension` → `local-helper`。

## 4. 阶段门槛

| 阶段 | 门槛 |
| --- | --- |
| P0 | `/health`、MCP 握手、CORS/401/403 与 Node 一致；`mcp_status` schema 逐字节相同；release 二进制 macOS ≤10MB、Windows ≤12MB —— **已完成** |
| P1 | 本机面路由差分全绿；PTY 游标（CJK/emoji/半截转义）与 Node 一致 —— **已完成**：`scripts/contract/{fs,terminal,tools}.test.cjs` 双引擎对拍，游标按 UTF-16 码元计数 |
| P2 | 5 个 SSE 端点帧序/重连一致；agent CLI 冒烟 mac+win —— **部分实现**：presence JSON/SSE 与基础分身文字问答已提供；agents/ACP、消息渠道和分身工具执行仍待完成 |
| P3 | 105 条路由与 13 个工具 schema 全部对齐 |
| P4 | 三平台安装/首启/升级/降级/双引擎/owner kill/卸载通过 |
| P5 | 冻结 v1 feed，发行物不再引用 `app/cli.cjs` |

## 5. 对拍与回滚

- `scripts/contract/*.test.cjs` 用同一套断言分别打 Rust 二进制与 Node 守护进程（不同端口、隔离 HOME）。
- `scripts/contract/harness.cjs` 是唯一启动入口；新增路由时两边必须同时加断言。
- 任一阶段出现回归：宿主把 `KEEPWORK_MCP_ENGINE=node` 或回退到自带 Node 运行时即可，Rust 线可单独回滚版本，不影响 v1 feed。
- 差异必须显式登记在测试里（例如 P1 的 `tools/list` 只列 5 个可移植工具、`/admin/status` 无 `nodeVersion`、`fetch_url` 无 headless 渲染），不允许“看起来一样”。

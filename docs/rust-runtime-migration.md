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

`/health` 只声明已经实现的能力：P0 只返回 `requireAuth`、`workspaceRoot`、`runtimeEngine`、`runtimeProduct`；`terminalApi`、`agentSessionApi`、`browserApi`、`messagingApi`、`personasApi` 等在对应阶段完成前不出现，AIChat 会按“能力缺失”降级。

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
| P0 | `/health`、MCP 握手、CORS/401/403 与 Node 一致；`mcp_status` schema 逐字节相同；release 二进制 macOS ≤10MB、Windows ≤12MB |
| P1 | 本机面路由差分全绿；PTY 游标（CJK/emoji/半截转义）与 Node 一致 |
| P2 | 5 个 SSE 端点帧序/重连一致；agent CLI 冒烟 mac+win |
| P3 | 105 条路由与 13 个工具 schema 全部对齐 |
| P4 | 三平台安装/首启/升级/降级/双引擎/owner kill/卸载通过 |
| P5 | 冻结 v1 feed，发行物不再引用 `app/cli.cjs` |

## 5. 对拍与回滚

- `scripts/contract/*.test.cjs` 用同一套断言分别打 Rust 二进制与 Node 守护进程（不同端口、隔离 HOME）。
- `scripts/contract/harness.cjs` 是唯一启动入口；新增路由时两边必须同时加断言。
- 任一阶段出现回归：宿主把 `KEEPWORK_MCP_ENGINE=node` 或回退到自带 Node 运行时即可，Rust 线可单独回滚版本，不影响 v1 feed。
- 差异必须显式登记在测试里（例如 P0 的 `tools/list` 只列 `mcp_status`、`/admin/status` 无 `nodeVersion`），不允许“看起来一样”。

# Keepwork MCP：Node / Rust 兼容与迁移契约

本文件规定 `apps/mcp-rust`、Node MCP `apps/mcp-runtime` 与桌面宿主的稳定边界。**当前功能范围与平台验证状态只维护在 [Rust 产品能力矩阵](rust-capability-matrix.md)**；此前含版本实测与旧阶段状态的原文保留在 [历史归档](history/rust-runtime-migration-20261113.md)。旧记录中的“未实现”不能覆盖后续源码实现，历史通过也不代表当前安装包已通过真实账号/所有平台验收。

`aichat-rust` 的默认 MCP 是 Rust。Node 仍为用户显式选择的兼容路径；其他宿主可继续单独发行 Node。网页、桌面、MCP 三者独立发布，不要求版本相等，缺少可选能力不能触发隐式引擎/provider切换。

## 不变的外部契约

| 项 | 约定 |
| --- | --- |
| 监听 | 仅 `127.0.0.1:8089`；`KEEPWORK_MCP_PORT` / `--port` / `config.json` 沿用既有优先级 |
| 服务身份 | `/health.name: keepwork-mcp`；`/health.version: 0.1.2` 是协议版本，不是桌面/MCP产品版本 |
| 实际运行身份 | `/health.runtimeEngine/runtimeProduct/runtimeVersion/runtimeCommit`；缺失可选字段表示未知。编译身份由二进制 `--build-info` 独立验证，不能用宿主环境变量伪造 |
| MCP | Streamable HTTP，initialize、nextCursor分页、Mcp-Session-Id、GET SSE、重复GET 409；`keepwork/streamedResponses` v1 显式协商，legacy保留JSON回复 |
| Origin / 鉴权 | 保持 Keepwork、localhost、127.0.0.1 的既有allowlist和路由鉴权规则；配对token默认关闭。兼容不放宽任何Origin、owner、路径、权限或审批检查 |
| 工作区 | `--root` > `KEEPWORK_MCP_ROOT` > `config.json.workspaceRoot` > `~/.keepwork-mcp/workspace`，保留default槽位；应用授权root不等于任意路径授权 |
| 本机持久化 | token为24字节hex、0600；instance.json保留pid/port/startedAt/name。persona、messaging及CLI历史沿用兼容布局，不跨owner自动合并 |

客户端读取显式能力与具体动作的合同。字段缺失/未知时保持普通聊天可用；不支持、离线、鉴权、权限和临时失败分别处理。服务端接受legacy省略的参数与旧默认值；新语义无法兑现时在提交前明确拒绝，不能静默忽略隔离上下文、权限或执行保证。

## 原生会话、分身与消息

原生 `/agents` 会话已有ACP、Codex、Claude和Antigravity适配、owner隔离、状态流、审批/问题、停止与恢复，以及登记当前网页工具的revocable上下文。图片轮次为可选 `agentImageTurnApi: v1`，Codex/Claude使用原生图片块，ACP必须握手声明支持；Antigravity仍为文字。Codex原生历史读取/显式继续已实现；其他provider的原生历史目录导入是独立未提供能力，不应与已登记会话恢复混为一谈。详细边界与回归入口见能力矩阵及 [MCP README](../apps/mcp-rust/README.md#native-cli-sessions)。

每个变更请求先持久化requestId与receipt，再提交。断流、取消、重启或未知提交结果不能自动重放，也不能换ID自动重发。保持原thread/turn/item ID、游标、模式及owner/conversation/page/generation；旧页面/过期结果不能答复新页。根目录变化须明确处理，不能把它当同一会话继续执行。

后台文件工具只提供明确授权的本机空间，修改仅Craft；云端/Git操作仍需原在线网页工具。Git草稿import/get/drop/ack保留数据与冲突，未验证remote base不得标成功。CLI只得到可撤销的临时工具能力，得不到网页登录、Git或全局账号凭据。

Persona对话通过Keepwork执行器使用有界历史/AGENTS.md及四个本地工具；terminal仅允许单条dws/lark-cli。`taskContextVersion: 1` 表示isolated不携带旧历史/摘要，省略保持旧行为。实际工具计数来自执行元数据，缺失表示未知。渠道自动文字回答与persona工具循环是不同执行路径，不能推断消息pump已有原生CLI或无头worker能力。钉钉/飞书管理、显式历史刷新、图片附件及owner主动Circles操作按各自能力开放；自动多分身群路由、多电脑协调、微信等范围见矩阵。

## 独立运行时与更新清单

Node v1 feed保持原路径与旧清单，不覆盖、不改成Rust。Rust使用独立v2命名空间，MCP平台名为 `macos/windows/linux`，架构为 `arm64/x64`；桌面自身feed继续原来的 `darwin/win32` 命名，不改地址。

| 发行物 | 路径 / 合同 |
| --- | --- |
| Node MCP稳定feed | `mcp-stable/<platform>-<arch>.json`，schemaVersion 1，原product与Node布局 |
| Rust MCP稳定feed | `mcp-stable-rs/<platform>-<arch>.json`，schemaVersion 2，product `keepwork-mcp-runtime`，engine `rust` |
| Rust归档 | 独立Rust命名空间下的不可变版本归档；至少含runtime.json、LICENSE、bin/keepwork-mcp[.exe]；其它技能/资源按实际包登记，不含Node app/或node_modules |

Rust更新feed的必要身份示意如下。地址和版本是格式说明，**不是已发布下载链接**：

```json
{
  "schemaVersion": 2,
  "product": "keepwork-mcp-runtime",
  "engine": "rust",
  "platform": "macos",
  "arch": "arm64",
  "version": "0.2.0",
  "commit": "<40 hex>",
  "url": "https://cdn.keepwork.com/keepwork/mcp-stable-rs/<version>/<archive>.zip",
  "sha256": "<64 hex>",
  "size": 123456
}
```

归档内runtime.json保持v2 Rust身份，并提供 `entry: bin/keepwork-mcp`（Windows带.exe）；args/env沿用受验证运行时合同。Node旧清单省略engine时仍按Node默认值处理；Rust更新不能依赖省略字段来猜引擎。不同引擎不比较产品版本，不能从Rust feed激活Node或反向替换。

更新流程必须满足：

1. 下载前校验schema/product/engine/platform/arch/合法版本、40位commit、64位SHA-256与正size；只接受既有可信HTTPS更新目标，拒绝重定向与超限响应。老Node v1解析和默认值继续可用。
2. 校验完整归档字节数与摘要，受限解压，拒绝穿越/绝对路径/链接逃逸和超限归档。runtime.json身份与feed一致；嵌入Rust二进制 `--build-info` 的产品、版本、commit/target等须与候选一致，不能给旧binary套新manifest。
3. 检查/下载仅生成pending，**不自动停止正在运行的服务**。用户点击更新可显式应用；下一次宿主启动且需要启动本地服务时，保留原Node的启动选择规则：pending必须属于显式选择的引擎，且严格新于已验证current/bundled的同引擎最高版本。同版本不同commit的候选仅允许显式apply，普通启动继续使用已验证版本。显式激活前重新核对监听身份、PID、engine、owner与本次候选；外部owner不能借更新按钮被终止。任务结果不确定时不自动重发。
4. 候选启动后核对实际PID、engine、version、commit与健康状态，成功后才提升current。失败先回退已验证current/previous，再考虑已验证bundled；回滚不授权普通启动降级或跨引擎替换，用户数据保留。记录失败原因，不能把端口上任意旧服务的200当作新候选成功。附着到既有peer时，版本、commit、构建时间与引擎仅来自本次实际响应；缺少字段保持未知并清理旧peer残留，不能用本地候选身份填充。元数据未知不阻止普通连接，也不能作为跨引擎接管的证据。
5. 更新失败/离线保留当前可用版本、原用户数据及pending身份。不把没有发布的feed或网络错误展示为“已是最新”；提供局部原因和手动重试。Node v1与桌面自身feed不受Rust独立发行影响。

本轮实现与本地候选/清单验证不表示CDN已发布或已执行真实安装升级；实际产物、上传与原生结果分别写入发布回执。准备可审查的本地归档和v2 feed时，在新的输出目录运行以下入口（目标/二进制路径按实际构建修改）；脚本校验编译身份并生成zip/json，不上传：

```sh
node apps/mcp-rust/scripts/package-runtime.cjs --target aarch64-apple-darwin --binary apps/mcp-rust/target/release/keepwork-mcp --out .test-runtime/mcp-runtime-package
```

## 宿主选择、所有权与启动

日常开发 `pnpm tauri dev`、`pnpm dev:rust`、VS Code Rust Desktop Start及标准 `make:mac/make:win:*` 默认构建Rust MCP。Node仅在 `pnpm dev:node`、`--mcp-node` 或 `AICHAT_MCP_ENGINE=node` 时显式选择；不存在通用的 `KEEPWORK_MCP_ENGINE=node` 自动回退合同。准备失败中止，不静默安装依赖或换引擎。

显式 `AICHAT_MCP_BUNDLED_DIR` 优先于 `AICHAT_MCP_RUNTIME_DIR`，必须通过所选引擎的清单与入口验证。开发启动在独立 `src-tauri/target/dev-mcp-runtime/rust-*` 准备候选，不覆盖存活daemon的文件。目录和引擎选择仅下次宿主启动生效，不会动态替换共享8089。

新版本接管仅限已识别为桌面管理的服务，同引擎只有候选严格较新时才考虑。桌面自动启动/心跳对VS Code、Local Helper及其他外部owner的兼容服务保持attach；同引擎较新不是跨owner终止服务的授权，身份不兼容时报告冲突。停止桌面管理的服务前，重新探测并核对真实PID、owner与候选适用条件；身份或所有者变化立即停止接管，不全局按进程名结束。遇到EADDRINUSE先识别/attach，不启动第二个监听器。退出编辑器窗口不能结束共享daemon。

Vite开发页固定 `127.0.0.1:1430`，只复用身份和真实checkout匹配的服务；未知占用者不被终止、不自动换端口。本地AIChat源码服务为源码目录+入口持久绑定loopback origin；既有浏览器owner记录不因端口/入口变化自动迁移或合并。

## 可选网页唤起合同

Rust与Electron共享Bridge v1的可选 `capabilities.launchIntents: true`，只允许 `keepwork-secondbrain://open` 与 `keepwork-secondbrain://onboarding`（可有末尾 `/`）。拒绝query/fragment/其它路径/凭据；URL不携带文件、令牌或命令。

- `open` 只显示/聚焦当前窗口；冷启动/Windows第二实例/macOS open-url保留有效意图，直到可信主框架ready。普通页面失败不能当作意图已消费。
- `getLaunchIntent()` 标记可信主文档ready并返回 `{id,kind}` 或null，kind为first-launch/onboarding；`onLaunchIntent(callback)` 仅通知重新读取，返回取消订阅函数，不携带外部payload。
- `acknowledgeLaunchIntent(id)` 只消费匹配当前意图ID，并持久保存“已提供首次引导”；打开失败不ack。显式onboarding可替代first-launch，重复同类请求合并；旧ID和旧文档不能消费新意图。
- 准备页、iframe、登录弹窗不获此桥。旧网页可忽略该能力，新网页在旧宿主继续手动向导；没有可选字段不代表整个Bridge损坏，也不要求更新MCP。

## 发布、对拍与回滚验收

本轮及以后每个变更按 [Rust最终包验收](acceptance/rust-desktop-release.md) 留存 [v1结构化证据](acceptance/rust-release-evidence.schema.json)。source、fixture、native、packaged、live分开；真实账号/设备/干净机条件未满足时保持pending/blocked。

`scripts/contract/*.test.cjs` 使用隔离profile/端口对Rust和已构建Node运行时执行相同断言；记录任一引擎被跳过的事实。跨边界变更至少覆盖新新、新客户端+旧server、新server+旧client合同、可选字段缺失/未知、404/422、重连/降级以及普通操作。fixture不代表所有已发布版本实连。差异如Rust静态fetch、未移植路由须登记，不伪造空成功。

实际激活或回退前先准备并验证候选，再核对服务owner、活跃/未知任务与持久数据；只读诊断不自动切换共享进程。发布清单只在对应最终不可变归档上传、大小/摘要与目标验证通过后提升。此前旧阶段P0–P5是迁移目标，不作为当前功能完成度百分比或跨平台验收结论。

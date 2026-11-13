# CDN 版本与更新清单规范

桌面客户端、Rust MCP 和 Node MCP 独立发行。七牛 CDN 上的 JSON 更新清单同时承载版本号和对应安装包身份；客户端以清单中的完整候选决定是否更新，不再维护一份可能与下载包脱节的纯文本版本号。相同产品的版本只在相同引擎、平台、架构和通道内比较，不要求桌面与 MCP 版本相等。

本文规定清单合同和发布顺序。文档、源码检查或本地生成 JSON 不表示线上清单已经更新。最终包和实际发布状态按 [Rust 发布包验收](acceptance/rust-desktop-release.md) 留存证据；运行时激活规则见 [Rust 迁移契约](rust-runtime-migration.md)。

新发布清单的结构见 [update-manifest.schema.json](schemas/update-manifest.schema.json)，发布时的字段、时间、目标与历史格式兼容校验见 [update-manifest.cjs](../scripts/lib/update-manifest.cjs)。JSON Schema 描述发布格式，不能代替包字节、嵌入身份和验收回执验证；历史客户端继续按原来的兼容合同读取旧字段。

## 地址与通道

公开下载域名为 `https://cdn.keepwork.com`。保留以下已有对象 key，不以新文件名切断已安装客户端：

| 更新流 | 可变版本清单 key | 包的身份与路径 |
| --- | --- | --- |
| 桌面 v1 | `keepwork/aichat-desktop/<target>/latest-client.json` | 原生 EXE / DMG：`keepwork/aichat-rust/<version>/<fileName>`；已有顶层 Launcher ZIP 保持原样 |
| Rust MCP v2 | `keepwork/mcp-stable-rs/<platform>-<arch>.json` | 不可变 ZIP：`keepwork/mcp-stable-rs/<version>/<platform>-<arch>.zip` |
| Node MCP v1 | `keepwork/mcp-stable/<platform>-<arch>.json` | 继续原 Node 清单与下载合同，不用 Rust 内容覆盖 |

桌面 `<target>` 为 `win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64`。MCP 的 `<platform>` 为 `windows`、`macos` 或 `linux`，`<arch>` 为 `x64` 或 `arm64`；只发布已有对应产物并完成验收的目标，清单存在不代表其他目标已经交付。桌面原生清单的 `platform` 使用 `windows` / `macos`，与既有 URL 中的 `win32` / `darwin` 区分；历史字段保留原值。

`AICHAT_UPDATE_FEED_URL` 和 `AICHAT_MCP_FEED_URL` 是显式通道覆盖。切换地址不授权换引擎、降级或复用其他地址的远端版本缓存。Windows CEF / 外层 Launcher 兼容安装保留自己的通道与签名合同，不通过普通 Tauri 清单替换外层启动器。

## 字段语义

清单使用 UTF-8 JSON、camelCase 字段。新发布器输出下表要求的身份字段；旧格式中原本可省略的字段保持可省略，未知附加字段不得让旧客户端失效。消费者不能用缺失字段猜测安全敏感身份。

| 字段 | 含义与约束 |
| --- | --- |
| `schemaVersion` | 清单协议版本，独立于产品版本；桌面原生清单为 `1`，Node MCP 为 `1`，Rust MCP 为 `2`。历史桌面 ZIP 清单省略时仍可读取，新发布器可补上缺失的 `1` |
| `product` | 更新对象；桌面为 `aichat-desktop`，Rust MCP 为 `keepwork-mcp-runtime`，Node MCP 为 `keepwork-mcp-node-runtime`。已有历史桌面字段保持原样 |
| `engine` | MCP 执行引擎。Rust v2 必须显式为 `rust`；Node v1 的历史省略值仍按 Node 处理，新写入时为 `node`。桌面实现使用 Rust 不代表桌面清单要声明 MCP 引擎 |
| `platform` / `arch` | 包适用的系统和架构，须与请求目标、包内清单和实际二进制一致。Universal DMG 可由两个 Mac 清单引用同一个文件，各清单仍标明自己的目标架构 |
| `version` | 此候选所属产品的版本号，新发布使用不含 `v` 前缀的 `major.minor.patch`。不使用 MCP 协议版本代替运行时版本；嵌套 `installer.version` 独立于历史顶层 ZIP 版本 |
| `commit` | 构建候选对应的 40 位 Git commit；MCP 必需。桌面原生包可附加，不能把发布时 checkout 的 commit 直接填给另一个源码构建的包 |
| `sourceHash` | Rust 候选的源码输入 SHA-256，与嵌入二进制身份一致；新 Rust 发布清单与包内身份必须包含该字段。历史消费者可忽略该附加字段 |
| `builtAt` | 真实构建时间，UTC ISO 8601，例如 `2026-11-13T08:00:00.000Z`。无法从构建记录取得时省略并显示未知；不得用上传时间、文件 mtime 或服务启动时间代填 |
| `publishedAt` | 此候选首次发布到当前清单的时间，UTC ISO 8601；同候选重试保留原时间。它不代替 `builtAt` |
| `url` | 对应包的公开 HTTPS 地址，不含凭据、令牌或 fragment；生产版本指向 CDN。显式 `127.0.0.1` HTTP 仅用于隔离测试夹具，不进入线上清单 |
| `fileName` / `format` | 下载文件名及格式；文件名不得携带目录。桌面原生候选为 Windows `exe`、macOS `dmg`；旧 ZIP 保留原用途，不因字段存在就宣称可安装 |
| `size` | 完整下载字节数，正整数。MCP 归档不得超过客户端已有的 500 MiB 限制；下载后按实际字节数复验 |
| `sha256` | 完整包字节的 64 位小写十六进制 SHA-256；先校验实际文件，再写入清单。不能以版本号、HTTP 200、ETag 或文件名代替完整性检查 |

`checkedAt`、`downloadedPath`、`stale`、下载进度及错误是客户端本地状态，不是 CDN 发布身份。未知时间或身份显示未知；不填 `0`、当前时间或其他产品的版本来制造完整结果。

## 桌面 v1：保留 ZIP，追加原生安装包

已有清单顶层的 legacy ZIP 下载字段与附加字段全部保留，追加或更新 `installer`；缺失的 `schemaVersion`、`product`、`platform` 和 `arch` 可按既有通道与目标补齐。已有身份值必须通过校验，显式冲突时拒绝发布，不覆盖原值来掩盖冲突。新客户端优先使用 `installer`；其 `version`、`publishedAt`、`url`、`size` 和 `sha256` 描述同一个原生包，不能混用顶层 ZIP 的摘要或大小。历史 `installer` 没有独立版本时沿用顶层 `version`；新发布器总是写出独立版本。

下例仅演示结构，版本、地址和摘要不代表已发布产物：

```json
{
  "schemaVersion": 1,
  "product": "aichat-desktop",
  "platform": "macos",
  "arch": "arm64",
  "version": "0.1.12",
  "format": "zip",
  "fileName": "Keepwork-Launcher-macos-arm64.zip",
  "url": "https://cdn.keepwork.com/keepwork/aichat-desktop/darwin-arm64/Keepwork-Launcher-macos-arm64.zip",
  "size": 123456,
  "sha256": "<原有 ZIP 摘要，保持不变>",
  "installer": {
    "version": "0.3.0",
    "publishedAt": "2026-11-13T08:00:00.000Z",
    "format": "dmg",
    "fileName": "Keepwork_0.3.0_universal.dmg",
    "url": "https://cdn.keepwork.com/keepwork/aichat-rust/0.3.0/Keepwork_0.3.0_universal.dmg",
    "size": 234567,
    "sha256": "<原生 DMG 的 64 位 SHA-256>"
  }
}
```

没有历史清单时，顶层写入 `schemaVersion: 1`、`product`、`platform`、`arch` 和原生包描述，同时保留同一描述的 `installer`。这不授权把已有 ZIP 顶层改成原生包。未知或无效的 `installer` 不静默回落到另一个包。

旧 Rust 客户端仅识别顶层地址，不能靠新增字段自动自救；需要手动安装支持 `installer` 的版本后才能接回后续更新。Launcher 的签名稳定指针保持独立，不在这次清单迁移中改写。

## Rust MCP v2：包与二进制身份一致

Rust 清单必须包含 `schemaVersion: 2`、`product: keepwork-mcp-runtime`、`engine: rust`、目标、版本、commit、sourceHash、fileName、URL、size 和 SHA-256。以下仅为结构示意：

```json
{
  "schemaVersion": 2,
  "product": "keepwork-mcp-runtime",
  "engine": "rust",
  "platform": "macos",
  "arch": "arm64",
  "version": "0.3.0",
  "commit": "<40 位 Git commit>",
  "sourceHash": "<64 位源码输入 SHA-256>",
  "publishedAt": "2026-11-13T08:00:00.000Z",
  "fileName": "macos-arm64.zip",
  "url": "https://cdn.keepwork.com/keepwork/mcp-stable-rs/0.3.0/macos-arm64.zip",
  "size": 345678,
  "sha256": "<完整 ZIP 的 64 位 SHA-256>"
}
```

归档至少含 `runtime.json`、`LICENSE` 和 `bin/keepwork-mcp`（Windows 带 `.exe`）。包内 `runtime.json` 与远端清单的产品、引擎、目标、版本、commit 一致；Rust 原生二进制的嵌入编译身份还须匹配目标 triple 与源码摘要。没有真实构建时间时不生成虚假的 `builtAt`。不能给旧二进制套新版本号，也不能把 Node 内容放入 Rust v2 通道。

## 发布、缓存与回滚

1. 先准备版本固定的最终包、本地候选清单、各目标身份和验收证据。桌面安装包先完成四处版本同步；MCP 版本保持独立。实际发布前审阅这些具体产物和计划，不以源码测试代替最终包验收。
2. 检查现有清单及不可变对象。拒绝通道版本倒退、同版本不同包或不同摘要；重试只接受相同身份与字节。源站使用禁止覆盖策略，CDN 缓存的 404 不能授权覆盖源站已有对象。
3. 先上传全部将被本次指针引用的不可变包，刷新必要缓存，并从最终公开下载 URL 下载复验大小、SHA-256 和目标身份。任何一个必需包失败时保持旧指针，不发布悬空链接。
4. 包验证通过后才替换相应可变 JSON 指针。发布器串行提升同一组稳定指针，避免不同版本工作流交错写入；各 JSON 对象完整替换。随后刷新清单 URL，重新读取无额外查询参数的用户实际地址，核对版本、身份及包下载结果。
5. 可变 JSON 使用 `Content-Type: application/json` 和短缓存，推荐 `Cache-Control: public, max-age=60, must-revalidate`；不可变版本包推荐 `public, max-age=31536000, immutable`。七牛源站元数据和 CDN 缓存策略须实际配置并实测，文档中的推荐值不表示线上已生效。客户端主动检查应请求重新验证，CDN 发布后仍需刷新旧缓存。
6. 保存发布前后清单、上传对象 key、大小/摘要、公开 URL 验证结果、时间及测试回执。下载或安装失败保留候选身份；服务激活失败按运行时合同回退已验证版本。紧急通道回退是单独审阅的发布操作，不能通过覆盖同版本不可变包实现。

Rust MCP 现有 CI 的 build/package 不等于 CDN promotion。独立入口为 [mcp-rust-publish.yml](../.github/workflows/mcp-rust-publish.yml)，只接受手动触发，`publish` 默认 `false`。默认 review 下载指定 artifact，验证最终归档与嵌入身份，不上传，也不表示完整发布验收通过；只有显式选择发布才进入 `rust-runtime-stable` environment 并运行完整验收校验。仓库必须实际配置该 environment 的发布审批保护，工作流中出现 environment 名称本身不证明审批已配置。

本地入口为 [publish-runtime.cjs](../apps/mcp-rust/scripts/publish-runtime.cjs)，默认只预览候选；只有 `--publish true` 且没有 `--dry-run` 才申请发布。发布前必须提供匹配最终归档的 `--report`，并通过 [发布证据门禁](acceptance/rust-desktop-release.md)：`verify --require-complete`、源码与最终产物身份一致、必要验收项完成及干净的发布源码。未执行的真实账号、硬件或安装测试保持 pending / blocked，不改成通过。普通 push 的测试和构建不隐式发布；本次准备文档或入口不执行上传、刷新 CDN 或替换稳定指针，实际发布须取得针对最终产物的批准。

## 客户端失败与兼容行为

- HTTP 404、断网、认证或解析错误分别显示实际原因，不报“已是最新”。保留当前可用服务、用户数据和已验证 pending；两条更新流独立，MCP 失败不阻断桌面检查或普通聊天。
- MCP 本地远端缓存已通过 `latestSource` 绑定原始 feed URL、product、engine、platform 和 arch。离线只能展示同一来源的已验证结果，并标记 `stale`；切换引擎、目标或 feed 后不套用旧版本。旧缓存没有来源字段时显示远端未知，保留磁盘记录和现有运行时，不根据版本号猜来源。桌面 `update-metadata.json` 目前仍没有来源绑定字段，跨自定义 feed 的桌面缓存隔离尚待补齐；不能把本轮 MCP 的修复结果视为桌面也已完成该能力。
- 有效远端版本等于或低于本机时不下载、不降级；旧 ZIP 不应被当作需要安装的更新而报错。只有实际较新的候选才要求满足当前平台的安装合同；较新但仅 ZIP、缺摘要或身份错误时明确不可用，按钮保持禁用。
- 下载只暂存；桌面安装需用户确认，MCP 激活保留 PID / owner 复验与外部宿主保护。不因为清单更新而停止外部 VS Code / Local Helper 服务，不自动重放结果不确定的任务。
- 兼容回归覆盖新客户端与历史顶层清单、独立 `installer` 版本、旧客户端读取新清单、旧/新 MCP 合同，以及缺字段、404、断网、切流和重连。隔离夹具通过只证明对应合同；公开清单、最终下载包及实际安装升级分别记录结果。

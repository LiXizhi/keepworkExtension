---
name: rust-release
description: 发布 KeepWork AIChat Rust 桌面端及 MCP Rust 服务器；支持 /rust-release 双产品发布与 /rust-release mcp-server 仅发布 MCP Rust。执行构建、CDN 上传和 feed 提升，核对下载地址；新版本打包、补发或排查发布流水线时使用。
---

# Rust 双产品发布

用户说“按 rust-release 发新版本”或“打包新的版本”时，默认完成桌面端和 MCP Rust 服务器两条发布链。
除非用户明确限定“只发桌面”或“只发 MCP”，不能省略 `Rust MCP daemon` 构建 Action，
以及 **Review or publish an accepted Rust MCP runtime** 上传 CDN 的 Action。
用户只要求修改 Skill、总结或解释流程时，仅处理文档，不触发发布。

## 调用命令与参数

将下面命令作为聊天中的 Skill 调用指令解析，先确定发布范围，再选择后续步骤：

| 调用方式 | 执行范围 |
| --- | --- |
| `/rust-release` 或 `/rust-release all` | 发布桌面端和 MCP Rust 服务器 |
| `/rust-release mcp-server` | **仅发布 MCP Rust 服务器**，从其清单与线上 MCP feed 确定下一个版本 |
| `/rust-release mcp-server X.Y.Z` | 仅发布 MCP Rust 服务器，使用明确指定的 MCP 版本 |

`mcp-server` 模式的执行顺序：

1. 检查 MCP 清单、线上 feed 和源提交；只同步 MCP 的两个版本文件，不修改桌面版本。
2. 执行 **Rust MCP daemon**，或复用本次相同提交、相同 MCP 版本且已成功的构建产物。
3. 逐平台执行 **Review or publish an accepted Rust MCP runtime**，显式传入 `publish=true`。
4. 确认各平台 publish job 成功，核验 MCP CDN 的版本、提交、归档大小和 SHA-256，汇总发布地址。
5. 把本次新增、修复和版本提交合并并推送到 `main`，核对远端已包含这些提交。

该模式执行第 1、3、4 节、第 5 节的 MCP 核验及第 6、7 节的收尾，跳过第 2 节桌面发布。
不触发桌面打包、不创建桌面 `v<desktop_version>` tag、不更新桌面 feed 或桌面 Release 的 Latest 标记。
未知参数先澄清，不回退为默认双产品发布；指定版本不得被自动替换。

| 产品 | 构建 Action / 文件 | CDN 发布 |
| --- | --- | --- |
| aichat-rust 桌面 | AIChat Rust release packages / `.github/workflows/aichat-rust-windows-release.yml` | 同一 workflow 在发布 tag 上上传安装包、提升三个桌面 feed 并写 Release 正文 |
| mcp-rust 服务器 | **Rust MCP daemon** / `.github/workflows/mcp-rust.yml` | 构建只生成 artifacts；还必须逐平台运行 **Review or publish an accepted Rust MCP runtime** / `.github/workflows/mcp-rust-publish.yml` 上传归档并提升 MCP feed |

**桌面安装包捆绑新版 MCP，不等于独立 MCP 服务器已上传 CDN。**
`Rust MCP daemon` 变绿也不等于 CDN 已更新。两条发布链和 CDN 核验全部完成后，才能报告“双产品发布完成”。

## 1. 确认版本与源提交

优先从最新 `main` 发布，先同步远端并检查工作区、已有 tag 和线上 feed。保留用户尚未提交的其他工作，
不要仅凭历史分支名判断哪条线更新。桌面和 MCP 独立升版，不要求版本相等；不能用更高版本号掩盖功能回退。

```bash
git status --short --branch
git fetch origin --tags
git tag -l 'v*' 'aichat-rust-v*' | sort -V | tail -5
for t in darwin-universal win32-x64 win32-arm64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/aichat-rust/$t/latest-client.json"
done
for t in macos-arm64 windows-x64 linux-x64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/mcp-stable-rs/$t.json"
done
```

按调用范围确定 `desktop_version`、`mcp_version` 和本次发布的完整提交 SHA。
`mcp-server` 模式只需要 `mcp_version`，不要求提供桌面版本。受影响产品的版本文件必须同步：

- 桌面：`apps/aichat-rust/package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 中
  `aichat-rust` 包、`src-tauri/tauri.conf.json`。
- MCP：`apps/mcp-rust/crates/keepwork-mcp/Cargo.toml`、`apps/mcp-rust/Cargo.lock` 中 `keepwork-mcp` 包。

完成相关检查并提交代码后再打包。双产品发布尽量使用同一个固定 tag 对应的源提交，
不能在构建中途移动 tag 或用变化中的分支头代替产物实际提交。

## 2. 桌面打包与发布

新桌面发布使用标准 `v<desktop_version>` tag，匹配四处桌面版本。
历史 `aichat-rust-v*` 仅用于重跑已有历史 Release。分支上的 dispatch 只构建，不上传桌面 CDN 或创建 Release。

```bash
git push origin HEAD:main
git tag -a v<desktop_version> -m "KeepWork 第二大脑 <desktop_version>（Windows / macOS）"
git push origin v<desktop_version>
gh workflow run aichat-rust-windows-release.yml --ref v<desktop_version>
```

记录这次 dispatch 的 run ID，等待 validate、Windows x64/ARM64、macOS Universal 和 publish 全部成功。
发布作业自动上传三个安装包、提升三个 `latest-client.json`，并在 Release 正文的
`<!-- keepwork-cdn-downloads:start -->` / `<!-- keepwork-cdn-downloads:end -->` 之间写桌面 CDN 下载表。

## 3. 必须执行 Rust MCP daemon

双产品模式可在桌面 Action 启动后并行执行 **Rust MCP daemon**（`mcp-rust.yml`）；
`mcp-server` 模式直接执行它，不等待或触发桌面 Action。
若本次提交已经有该 Action 的成功运行，核对 `headSha` 和产物后可复用，不重复构建。

```bash
gh workflow run mcp-rust.yml --ref <source-ref>
# 从本次 dispatch 返回的链接记录 mcp_run_id
gh run watch <mcp_run_id> --exit-status
gh run view <mcp_run_id> --json headSha,conclusion,url
```

双产品模式的 `source-ref` 通常为 `v<desktop_version>`；`mcp-server` 模式可用已推送的 `main`
或用户指定的 MCP 源 ref，不依赖桌面 tag。记录返回的完整 `headSha` 为 `mcp_commit`，
确认等于预期源提交，并检查各平台 job 成功且产物存在。不能复用其他提交或其他版本的同名 artifact。
当前构建矩阵如下；以后以 workflow 和实际产物为准：

| MCP target | artifact_name | 包与报告 |
| --- | --- | --- |
| macos-arm64 | `mcp-rust-validation-macos-latest` | `package/macos-arm64.zip`、`report.json` |
| windows-x64 | `mcp-rust-validation-windows-latest` | `package/windows-x64.zip`、`report.json` |
| linux-x64 | `mcp-rust-validation-ubuntu-latest` | `package/linux-x64.zip`、`report.json` |

发布 workflow 虽然列出六种 target，当前构建只产出上面三种。不要凭空声明其他架构已发布。

## 4. 执行 Review or publish an accepted Rust MCP runtime 上传 CDN

使用上一步的 `mcp_run_id` 和各平台 artifact，**逐平台触发名为 Review or publish an accepted Rust MCP runtime 的 Action**
（文件：`.github/workflows/mcp-rust-publish.yml`）。这一步才会把 MCP Rust 服务器上传 CDN。
下面命令按上表执行三次；`mcp_version` 是 MCP 自己的版本，`mcp_commit` 是构建产物的完整 40 位提交。
发布 workflow 的 `--ref` 应包含当前发布脚本；已有旧产物需要新版发布脚本时，ref 可以与产物源 ref 不同，
但 `run_id`、版本和 `commit` 必须始终匹配产物身份。

```bash
gh workflow run mcp-rust-publish.yml --ref <publisher-ref> \
  -f run_id=<mcp_run_id> \
  -f artifact_name=<上表完整 artifact_name> \
  -f target=<macos-arm64 或 windows-x64 或 linux-x64> \
  -f version=<mcp_version> \
  -f commit=<mcp_commit> \
  -f publish=true -f acceptance=deferred
```

每次记下 publish run ID，等待该 Action **completed successfully**，并确认 `review` 和 `publish` 两个 job
均为 success；`publish` 不能是 skipped。`publish` 默认是 false，省略 `-f publish=true` 只做 review，
即使整个 run 成功也没有上传。

```bash
gh run watch <mcp_publish_run_id> --exit-status
gh run view <mcp_publish_run_id> --json conclusion,jobs,url
```

归档和固定 feed 分别写到：

- `https://cdn.keepwork.com/keepwork/mcp-stable-rs/<mcp_version>/<target>.zip`
- `https://cdn.keepwork.com/keepwork/mcp-stable-rs/<target>.json`

发布器先验证版本、提交、目标、sourceHash、大小和 SHA-256，再上传并核验不可变 ZIP，最后更新固定 feed。
不得只改 feed 版本号、覆盖不同字节的同版本归档，或绕过发布器直接写 CDN。

### 验收模式

- 按本项目既有的 CI 发布约定，命令显式选择 `acceptance=deferred`：允许指定的六个验收门禁保留 pending，
  但 source/fixture 检查必须通过、源码必须干净，归档身份和字节校验仍然执行。
  缺少的 package-integrity、runtime-live-identity、runtime-update-rollback、compatibility-matrix、
  cli-live、messaging-live 验收会写入 Job Summary，不能称为完整实机验收。
- 用户要求完整验收时使用 `acceptance=required`。它要求完整报告，其中真实 CLI/消息验收需要真实账号与网络回执；
  当前 CI 的 source/fixture 报告不足以满足它。不得伪造 passed，或为了让流程变绿更改验收含义。
- workflow 默认仍是 `required`；不要把显式 `deferred` 改成静默默认。

## 5. 核对两个产品的 CDN，并补 GitHub Release

双产品模式检查桌面 Release 非 draft、三个安装包可下载、三个 `latest-client.json` 指向预期桌面版本。
`mcp-server` 模式跳过桌面检查及下列桌面示例命令，只检查 MCP。
MCP：对每个已发布 target 检查固定 feed 的 `version`、完整 `commit`、`url`、`size`、`sha256`，
然后下载**实际归档**核对大小和 SHA-256。不能只看 workflow 绿灯或 HTTP HEAD 200。

```bash
gh release view v<desktop_version> --json body,isDraft,assets
for t in darwin-universal win32-x64 win32-arm64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/aichat-rust/$t/latest-client.json"
done
for t in macos-arm64 windows-x64 linux-x64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/mcp-stable-rs/$t.json"
done
curl -fsSL "https://cdn.keepwork.com/keepwork/mcp-stable-rs/<mcp_version>/<target>.zip" \
  -o <本地核验文件>
shasum -a 256 <本地核验文件>
wc -c <本地核验文件>
```

若 feed 看起来仍是旧值，可加一次性 query 复查 CDN 缓存；不得因此跳过固定地址核验。
旧版归档应保持可下载。双产品模式将 MCP 各平台固定 feed、版本 ZIP 链接和 SHA-256 补到本次桌面 GitHub Release 正文，
保留桌面发布器的下载表及已有说明。用正文文件配合 `gh release edit --notes-file`，避免丢失原内容。
`mcp-server` 模式将地址和校验结果写入 MCP 发布回执；若用户指定了 GitHub Release 目标，
只更新该目标的 MCP 部分，不为独立 MCP 发布创建新的桌面版本。

## 6. 发布完成后合并并推送 main

授权记录（2026-11-13）：用户明确要求“以后都直接批准”，并要求发布完毕后提交、推送修改。
后续调用本 Skill 发布时，默认已授权本次发布范围内的提交、推送到 `main` 和合并发布修复 PR，
直接完成，不重复询问；用户当次明确收窄范围时，以当次要求为准。
此授权不关闭工具自动审批，不包含强推、删除或无关改动。自动审批拒绝时，先根据原因核对授权和范围；
无法在已授权范围内完成时，如实说明被拒动作与原因，不声称已经获批或完成。

双产品发布和 `mcp-server` 单产品发布都必须完成这一步。它属于用户已要求的发布收尾，
不要停在发布分支已推送，也不要把“是否合到 main”再次交回用户。

发布和 CDN 核验结束后，检查本次是否还有新增代码、修复、测试、版本或发布说明未提交。
只提交本次相关改动，保留无关工作；按 AGENTS.md 同步受影响产品版本并执行相应检查。
核对待提交 diff 后提交；已有发布修复 PR 时，核对其源提交和检查结果后按仓库规则合并。
记录发布源分支和需要保留的提交，再将本次改动合入最新 `origin/main`：

```bash
git fetch origin
git switch main
git merge --ff-only origin/main
git merge --no-ff <本次发布源分支> -m "Merge Rust release changes into main [skip publish]"
git push origin main
```

若本来就在 `main` 发布，不创建重复合并，只把本次新增或修复提交推送到远端 `main`。
有冲突时逐项保留双方已交付功能，修复后运行相关验证；不强制覆盖远端、不整批选一侧、不移动已有发布 tag。
`[skip publish]` 用于避免这次收尾 push 意外再次发布 Node runtime。
合并时新增的源码修复或升版属于后续提交，不修改已经发布的 tag、不可变归档或 feed 来伪装成同一份产物。

最后核对 `origin/main` 已包含本次发布源提交及后续修复提交（可用 `git merge-base --is-ancestor`），
汇报远端 `main` 的最终 commit。若推送被分支保护等服务器规则拒绝，按仓库既有合并流程处理并如实说明阻塞，
不能仅凭本地合并成功就说已推送主分支。

## 7. 完成与失败处理

双产品发布只有在以下步骤完成后才算结束：

1. 桌面 Action 完成安装包与桌面 CDN 发布。
2. **Rust MCP daemon** 构建成功，三个平台的版本和源提交正确。
3. **Review or publish an accepted Rust MCP runtime** 逐平台 completed successfully，
   且 publish job 成功完成 ZIP 上传和固定 feed 提升。
4. 两个产品 CDN 已核验，GitHub Release 同时包含桌面和 MCP 下载地址。
5. 本次新增及修复提交已合并并推送到远端 `main`，主分支包含完整发布代码。

汇总两个独立版本号、源提交、构建与发布 run 链接、各平台 CDN 地址、验收模式及未验证项目。
任何一个目标失败都明确列出，不把桌面成功说成双产品成功。
`mcp-server` 模式以 MCP 构建、逐平台 CDN 发布、核验及合并推送 `main` 全部完成为结束条件；仅汇总 MCP 版本与结果，
不把未执行的桌面步骤算作失败或待办。

失败时先查日志和已上传结果；产物未改变时可重跑相同发布参数，避免重复构建。
需要修改源码时升版并创建新 tag。保留已有 tag、Release 和 CDN 归档，不删改历史 tag。
写入结果不确定时先核对远端字节与 feed，再决定是否重试；不要改验收门禁或手工伪造 manifest。

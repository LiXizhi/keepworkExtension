---
name: rust-release
description: 打包或发布 KeepWork AIChat Rust 桌面端及 MCP Rust 服务器；支持现代版双产品、仅 MCP，以及显式选择的 Win7/Win8 专版流程。用于版本打包、发布与排查。
---

# Rust 双产品发布

用户说“按 rust-release 发新版本”或“打包新的版本”且未指定 Win7/Win8 时，默认完成现代桌面端和 MCP Rust 服务器两条发布链。
现代版模式中，除非用户明确限定“只发桌面”或“只发 MCP”，不能省略 `Rust MCP daemon` 构建 Action 和独立 MCP CDN 发布。
GitHub Actions 负责构建和保存 artifacts；**此设备经 `http://127.0.0.1:7890` 下载，再由此设备直连七牛上传**。
不再调用远端上传七牛的 Action，也不在代理不可用时回退到 GitHub 上传。
用户只要求修改 Skill、流程、总结或解释时，完成相应改动，不触发实际构建、发布或推送。
Win7/Win8 专版是独立流程，只在用户明确选择 Win7、Win8 或 Win8.1 兼容版时执行；普通双产品发布和 `mcp-server` 均不附带 Win7/Win8 构建或发布。

## 调用命令与参数

将下面命令作为聊天中的 Skill 调用指令解析，先确定发布范围，再选择后续步骤：

| 调用方式 | 执行范围 |
| --- | --- |
| `/rust-release` 或 `/rust-release all` | 发布桌面端和 MCP Rust 服务器 |
| `/rust-release mcp-server` | **仅发布 MCP Rust 服务器**，从其清单与线上 MCP feed 确定下一个版本 |
| `/rust-release mcp-server X.Y.Z` | 仅发布 MCP Rust 服务器，使用明确指定的 MCP 版本 |
| `/rust-release win7-win8` | 仅准备 Win7/Win8 x64 专版，按用户要求构建、打包或发布；先读取 [Win7/Win8 流程](references/windows7.md)，不执行下文的现代版双产品步骤 |
| `/rust-release win7` | `win7-win8` 的兼容别名，仍使用当前 Win7/Win8 专版身份和渠道，不生成旧 Win7 单系统渠道 |

`win7-win8` 模式覆盖 Windows 7 SP1 x64、Windows 8 x64、Windows 8.1 x64；能力边界、独立产物/更新地址、构建步骤及逐系统虚拟机验收见该参考文件，按需读取。
用户只授权实现、流程修改或本地打包时，不触发远端 workflow、推送、CDN 写入或公开 Release；
现有现代版发布授权不把一次 Win7/Win8 开发请求变成 Win7/Win8 发布请求。缺少任一目标系统的实测回执时，分别报告该系统未验证，不以一台机器的通过覆盖全部系统。

`mcp-server` 模式的执行顺序：

1. 检查 MCP 清单、线上 feed 和源提交；只同步 MCP 的两个版本文件，不修改桌面版本。
2. 执行 **Rust MCP daemon**，或复用本次相同提交、相同 MCP 版本且已成功的构建产物。
3. 用本 Skill 的下载脚本经本机代理下载三个 MCP artifacts，保留完整证据目录；本地预检后显式 `--publish true` 发布四个目标。
4. 确认本地发布命令成功，核验 MCP CDN 的版本、提交、归档大小和 SHA-256，汇总发布地址。
5. 把本次新增、修复和版本提交合并并推送到 `main`，核对远端已包含这些提交。

该模式执行第 1、3、4 节、第 5 节的 MCP 核验及第 6、7 节的收尾，跳过第 2 节桌面发布。
不触发桌面打包、不创建桌面 `v<desktop_version>` tag、不更新桌面 feed 或桌面 Release 的 Latest 标记。
未知参数先澄清，不回退为默认双产品发布；指定版本不得被自动替换。

| 产品 | 构建 Action / 文件 | CDN 发布 |
| --- | --- | --- |
| aichat-rust 桌面 | AIChat Rust release packages / `.github/workflows/aichat-rust-windows-release.yml` | tag 构建汇总为 `aichat-rust-release-packages`；本地上传安装包、提升三个桌面 feed 并公开 GitHub Release |
| mcp-rust 服务器 | **Rust MCP daemon** / `.github/workflows/mcp-rust.yml` | 本地下载三个原始 artifacts，校验证据后上传四个 ZIP 并提升 MCP feed |

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
for t in windows-x64 windows-arm64 macos-arm64 macos-x64; do
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

### 本机下载和上传环境

本机需有已登录的 `gh`、Node.js，以及可用的 `http://127.0.0.1:7890` HTTP 代理。
MCP 证据验证依赖仓库根目录的 Node 依赖；尚未安装时先执行 `npm ci --ignore-scripts`，已有依赖可复用。
从仓库根目录运行下文脚本。所有 GitHub `gh` 子进程（包括下载产物、修改 Release 和上传附件）
均使用该代理并剔除七牛密钥，清除 `NO_PROXY` 绕过项；
用精确 run ID、完整提交 SHA 和产品工作流校验成功的非 PR 构建，缺少或过期产物时中止。
每次 `--output` 使用全新目录，下载回执记录构建身份和本地文件校验值，不混入其他 run 的同名文件。

本地上传从环境读取 `KP_QINIU_ACCESS_KEY`、`KP_QINIU_SECRET_KEY`，不得把密钥写进参数、日志或仓库。
环境中缺项时先按下节加载本机 `ai-skill-accesskey/qiniu.yaml`，不要直接判定缺少凭据。
GitHub 仓库 secrets 不会自动出现在本机，不尝试导出仓库 secrets。
七牛发布器自身清除代理设置后直连七牛，沿用既有的不可变归档、SHA-256 和 feed 提升顺序。
默认仅预检；只有 `--publish true` 执行写入。保留下载目录与报告；发布日志和新增回执存到下载目录外，
不要向 artifacts 根目录添加文件，否则重试时下载回执的文件清单校验会失败。

### 本机七牛凭据：ai-skill-accesskey

本机七牛凭据保存在独立的 `ai-skill-accesskey` 仓库。以下位置均相对于本仓库根目录：

- 首选：`../ai-skill-accesskey/qiniu.yaml`。
- 备用：`../keepworksdk/.github/skills/upload-deploy-cdn-files/ai-skill-accesskey/qiniu.yaml`。

已有可用配置时直接在已授权的发布流程中加载，不再让用户重复提供密钥位置。
配置定位说明和对外回执使用相对路径，不写入个人绝对路径或用户名。

1. 当次用户明确指定的配置优先；未指定且两个环境变量已齐全时，直接使用环境变量。
   否则按上述顺序检查相对路径。
   不自动选择其他项目或账户的配置；明确指定的文件无效时报告该问题。
2. 使用安全 YAML 解析器（如 Python `yaml.safe_load`）读取选定文件；支持字段位于根对象或 `qiniu` 对象下。
   从同一文件成对映射 `accessKey` → `KP_QINIU_ACCESS_KEY`、`secretKey` → `KP_QINIU_SECRET_KEY`，
   不把不完整环境变量与另一份配置拼成一对。核对 `bucketName` 为 `haqi`、`publicDomain` 为 `https://cdn.keepwork.com`。
3. `scripts/publish-local.cjs` 仍只读取环境变量，不会自动发现 YAML。
   用加载包装器在内存中解析配置后调用其 `publishLocal`，或通过子进程的 `env` 注入这两个变量再执行原发布命令。
   密钥只进入发布进程环境，不写入 `.env`、临时文件、下载目录或回执；不 `cat` 配置、不用 shell `source` 或命令替换传递密钥。
   若解析器通过子进程返回数据，捕获到内存并处理，禁止把其原始输出或含配置行的解析异常写入日志。
4. 保持原有代理隔离：所有 `gh` 子进程通过 `githubEnvironment` 剔除七牛变量后使用本机代理；七牛请求直连。
   选定配置无效或默认查找均无可用配置时，才说明缺失或无效的路径并请求配置位置，不要求用户在聊天中粘贴密钥。

## 2. 桌面打包与发布

新桌面发布使用标准 `v<desktop_version>` tag，匹配四处桌面版本。
历史 `aichat-rust-v*` 仅用于重跑已有历史 Release。分支上的 dispatch 只构建；tag 上也只准备产物，不上传七牛或公开 Release。

```bash
git push origin HEAD:main
git tag -a v<desktop_version> -m "KeepWork 第二大脑 <desktop_version>（Windows / macOS）"
git push origin v<desktop_version>
gh workflow run aichat-rust-windows-release.yml --ref v<desktop_version>
```

记录这次 dispatch 的 `desktop_run_id` 和完整 `desktop_commit`，等待 validate、Windows x64/ARM64、
macOS Universal、`prepare-release` 全部成功。汇总 artifact 包含三个安装包、Windows manifests 和
`SHA256SUMS-<desktop_version>.txt`。在此设备下载、预检，再执行本地发布：

```bash
node .github/skills/rust-release/scripts/download-artifacts.cjs \
  --product desktop --run-id <desktop_run_id> --commit <desktop_commit> \
  --output .tmp/rust-release/desktop-<desktop_run_id>
node .github/skills/rust-release/scripts/publish-local.cjs \
  --product desktop --artifacts .tmp/rust-release/desktop-<desktop_run_id> \
  --version <desktop_version> --commit <desktop_commit> --tag v<desktop_version>
node .github/skills/rust-release/scripts/publish-local.cjs \
  --product desktop --artifacts .tmp/rust-release/desktop-<desktop_run_id> \
  --version <desktop_version> --commit <desktop_commit> --tag v<desktop_version> --publish true
```

本地脚本核对下载回执与构建校验和，再创建或复用 draft Release，调用原桌面发布器上传三个安装包。
三个安装包全部验证后才提升三个 `latest-client.json`，在 Release 正文的
`<!-- keepwork-cdn-downloads:start -->` / `<!-- keepwork-cdn-downloads:end -->` 区块写 CDN 下载表，
最后上传 GitHub 附件并公开 Release。失败时新建 Release 保持草稿；不得提前公开或替换附件绕过 CDN 校验。

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

### MCP 平台必须对应桌面的三个安装包

默认发布范围与 **AIChat Rust release packages** 一致，**不包含 Linux**：

| 构建组 / 桌面安装包 | artifact_name | 包与报告 |
| --- | --- | --- |
| Windows x64 | `mcp-rust-validation-windows-x64` | `package/windows-x64.zip`、`report-windows-x64.json` |
| Windows ARM64 | `mcp-rust-validation-windows-arm64` | `package/windows-arm64.zip`、`report-windows-arm64.json` |
| macOS Universal | `mcp-rust-validation-macos-universal` | `package/macos-arm64.zip`、`report-macos-arm64.json`；`package/macos-x64.zip`、`report-macos-x64.json` |

桌面是三个安装包；独立 MCP feed 按架构分开，因此对应四个 MCP target，不能把 macOS Universal
误写成只支持 ARM64，也不能虚构发布器尚不支持的 `macos-universal` ZIP。
两产品版本号继续独立，这里的“对应”指平台和架构覆盖一致。

`mcp-rust.yml` 只保留上述三个构建组，不构建或打包 Linux 发行产物。
Windows ARM64 使用原生 ARM64 runner；macOS Universal 组分别构建并打包两套原生切片，
不能把一个架构的 ZIP 复制改名当作另一个架构。目标架构的交叉编译成功不能冒充原生 live 验收通过。
历史 Linux CDN 归档和 feed 保留，不删除或改写；新发布入口不再接受 Linux target。

每个目标使用实际 artifact 名称，包内必须有 `package/<target>.zip` 和对应的 `report-<target>.json`，
且版本、提交、target 与二进制嵌入身份一致。可用以下命令列出构建产物，不根据 runner 名猜测架构：

```bash
gh api repos/LiXizhi/keepworkExtension/actions/runs/<mcp_run_id>/artifacts \
  --jq '.artifacts[] | select(.expired == false) | .name'
```

## 4. 本机下载并上传独立 MCP CDN

使用上一步的 `mcp_run_id` 和完整 `mcp_commit`，在此设备下载、预检，再本地发布。
下载器保留三个 artifact 的独立目录，包含原始 `package/`、各目标报告和日志；不能只下载 ZIP，
也不能把 Mac 两个报告合并为一个或改写 CI 的验收结果。

```bash
node .github/skills/rust-release/scripts/download-artifacts.cjs \
  --product mcp --run-id <mcp_run_id> --commit <mcp_commit> \
  --output .tmp/rust-release/mcp-<mcp_run_id>
node .github/skills/rust-release/scripts/publish-local.cjs \
  --product mcp --artifacts .tmp/rust-release/mcp-<mcp_run_id> \
  --version <mcp_version> --commit <mcp_commit> --acceptance deferred
node .github/skills/rust-release/scripts/publish-local.cjs \
  --product mcp --artifacts .tmp/rust-release/mcp-<mcp_run_id> \
  --version <mcp_version> --commit <mcp_commit> --acceptance deferred --publish true
```

本地脚本先对四个目标全部执行归档身份与验收预检，通过后才逐个调用
`apps/mcp-rust/scripts/publish-runtime.cjs` 上传。`mcp_version` 为 MCP 独立版本，
版本、完整提交、target、sourceHash、二进制嵌入身份和报告必须匹配。
发布器代码可来自后续修复提交，但不能把当前 HEAD、当前工作区或本机重跑的测试冒充原始 CI 证据。
历史只有 `report.json` 的 artifact 需先明确核对对应 target；若本地入口不支持该布局，报告不支持并保留原产物，
不得静默选择其他报告或回退到远端七牛上传。

旧 `.github/workflows/mcp-rust-publish.yml` 作为历史独立入口保留；本 Skill 不再触发该上传 Action。

归档和固定 feed 分别写到：

- `https://cdn.keepwork.com/keepwork/mcp-stable-rs/<mcp_version>/<target>.zip`
- `https://cdn.keepwork.com/keepwork/mcp-stable-rs/<target>.json`

发布器先验证版本、提交、目标、sourceHash、大小和 SHA-256，再上传并核验不可变 ZIP，最后更新固定 feed。
不得只改 feed 版本号、覆盖不同字节的同版本归档，或绕过发布器直接写 CDN。

### 验收模式

- 按本项目既有的发布约定，命令显式选择 `--acceptance deferred`：允许指定的六个验收门禁保留 pending，
  但 source/fixture 检查必须通过、源码必须干净，归档身份和字节校验仍然执行。
  缺少的 package-integrity、runtime-live-identity、runtime-update-rollback、compatibility-matrix、
  cli-live、messaging-live 验收会记录在本地发布输出，不能称为完整实机验收。
- 用户要求完整验收时使用 `--acceptance required`。它要求完整报告，其中真实 CLI/消息验收需要真实账号与网络回执；
  当前 CI 的 source/fixture 报告不足以满足它。不得伪造 passed，或为了让流程变绿更改验收含义。
- 本地入口默认仍是 `required`；不要把显式 `deferred` 改成静默默认。

## 5. 核对两个产品的 CDN，并补 GitHub Release

双产品模式检查桌面 Release 非 draft、三个安装包可下载、三个 `latest-client.json` 指向预期桌面版本。
`mcp-server` 模式跳过桌面检查及下列桌面示例命令，只检查 MCP。
MCP：对每个已发布 target 检查固定 feed 的 `version`、完整 `commit`、`url`、`size`、`sha256`，
然后直连 CDN 下载**实际归档**核对大小和 SHA-256。不能只看 workflow 绿灯、本地命令退出码或 HTTP HEAD 200。

```bash
gh release view v<desktop_version> --json body,isDraft,assets
for t in darwin-universal win32-x64 win32-arm64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/aichat-rust/$t/latest-client.json"
done
for t in windows-x64 windows-arm64 macos-arm64 macos-x64; do
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

1. 桌面 Action 生成安装包，此设备经 `127.0.0.1:7890` 下载、本地上传并完成桌面 CDN 发布。
2. **Rust MCP daemon** 构建成功，覆盖桌面三个安装包对应的四个 MCP target，版本和源提交正确。
3. 此设备经同一本机代理下载三个 MCP artifacts，本地发布命令完成四个目标的 ZIP 上传和固定 feed 提升。
4. 两个产品 CDN 已核验，GitHub Release 同时包含桌面和 MCP 下载地址。
5. 本次新增及修复提交已合并并推送到远端 `main`，主分支包含完整发布代码。

汇总两个独立版本号、源提交、构建 run 链接、本地下载回执和发布日志、各平台 CDN 地址、验收模式及未验证项目。
任何一个目标失败都明确列出，不把桌面成功说成双产品成功。
`mcp-server` 模式以 MCP 构建、逐平台 CDN 发布、核验及合并推送 `main` 全部完成为结束条件；仅汇总 MCP 版本与结果，
不把未执行的桌面步骤算作失败或待办。

失败时先查日志和已上传结果；产物未改变时可重跑相同发布参数，避免重复构建。
需要修改源码时升版并创建新 tag。保留已有 tag、Release 和 CDN 归档，不删改历史 tag。
写入结果不确定时先核对远端字节与 feed，再决定是否重试；不要改验收门禁或手工伪造 manifest。

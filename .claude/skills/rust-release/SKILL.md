---
name: rust-release
description: 发布 KeepWork AIChat Rust 桌面端与 MCP Rust 运行时到 GitHub Release 和 CDN；含版本号同步、tag 触发条件、CDN 提升、验收门禁选择与发布后核对。准备发版、补发或排查发布流水线时使用。
---

# Rust 双产品发布

发布两个独立产品，流程和门禁不同，不要混在一次操作里：

| 产品 | 版本源 | 发布方式 | CDN |
| --- | --- | --- | --- |
| aichat-rust（桌面） | `apps/aichat-rust/**` | tag + `aichat-rust-windows-release.yml` | `aichat-rust/<version>/` + 3 个 `latest-client.json` |
| mcp-rust（运行时） | `apps/mcp-rust/**` | `mcp-rust.yml` 构建 → `mcp-rust-publish.yml` 提升 | `mcp-stable-rs/<version>/<target>.zip` + `<target>.json` |

## 0. 先确认发布线

线上 desktop feed 的版本来自「自动更新线」分支（形如 `codex/auto-update-release-<日期>`），`main` 经常落后，
且可能不含自动覆盖更新能力。**不要从 main 发一个更高版本号**：feed 只校验版本单调递增，不校验功能对齐，
已装用户会"更新"到功能回退的版本，自动更新链会断。

发版前跑这三条，确定下一个版本号：

```bash
git fetch origin --tags
git tag -l 'aichat-rust-v*' | sort -V | tail -3
for t in darwin-universal win32-x64 win32-arm64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/aichat-rust/$t/latest-client.json" |
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))'
done
for t in macos-arm64 windows-x64 linux-x64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/mcp-stable-rs/$t.json" |
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))'
done
```

## 1. 版本号必须同步的文件

aichat-rust（四处都要改，缺一处 CI 或打包会不一致）：

- `apps/aichat-rust/package.json`
- `apps/aichat-rust/src-tauri/Cargo.toml`
- `apps/aichat-rust/src-tauri/Cargo.lock`（`name = "aichat-rust"` 那一段）
- `apps/aichat-rust/src-tauri/tauri.conf.json`

mcp-rust（两处）：

- `apps/mcp-rust/crates/keepwork-mcp/Cargo.toml`
- `apps/mcp-rust/Cargo.lock`（`name = "keepwork-mcp"` 那一段）

## 2. 桌面发布

**触发条件很关键**：`aichat-rust-windows-release.yml` 的 `publish` 作业只在 `refs/tags/aichat-rust-v*` 上执行。
在分支上 dispatch 只会构建、不会上传 CDN、不会建 Release。

```bash
git push origin HEAD:<release-branch>
git tag -a aichat-rust-v<ver> -m "KeepWork 第二大脑 <ver>（Windows / macOS）"
git push origin aichat-rust-v<ver>
gh workflow run aichat-rust-windows-release.yml --ref aichat-rust-v<ver>
```

发布作业自动完成：上传三个安装包到 CDN、提升三个 `latest-client.json`、创建 GitHub Release、
把 CDN 下载表写进正文（`<!-- keepwork-cdn-downloads -->` 标记之间）。版本说明需要另外补。

tag 打在失败之前时：先 `gh run cancel`，再删远端 tag（`git push origin :refs/tags/<tag>`）重打，
**确认 publish 作业没跑过**再移 tag，否则 CDN 已经写入，不能回退。

## 3. MCP 发布

两步，第一步只产生产物，第二步才写 CDN。

```bash
gh workflow run mcp-rust.yml --ref <tag-or-branch>
# 记下 run_id，然后逐平台提升
gh workflow run mcp-rust-publish.yml --ref <同一 ref> \
  -f run_id=<构建 run_id> \
  -f artifact_name=mcp-rust-validation-<os>-latest \
  -f target=<target> \
  -f version=<ver> -f commit=<构建 commit 完整 40 位> \
  -f publish=true -f acceptance=deferred
```

- 产物名：`mcp-rust-validation-macos-latest` / `-windows-latest` / `-ubuntu-latest`
- 包在 `package/<target>.zip`，报告在 `report.json`
- 只构建三个目标：`macos-arm64`、`windows-x64`、`linux-x64`。其余三个 target 没有产物。
- `commit` 必须是产物二进制里嵌入的那个 commit（不是当前分支头）。

### acceptance 怎么选

- `required`：要求完整验收报告。`cli-live`、`messaging-live` 需要真实账号 + 网络回执，
  CI 物理上产不出来，选它等于永远失败。
- `deferred`：允许跳过 6 个 CI 无法执行的门禁（package-integrity、runtime-live-identity、
  runtime-update-rollback、compatibility-matrix、cli-live、messaging-live），
  但 `source-checks`、`fixture-contracts` 未通过仍会拒绝，`sourceDirty` 必须为 false，
  跳过的门禁会写进 Job Summary。

deferred 是显式选择，不要为了方便改成默认值。要发布「已完整验收」的版本时仍然走 `required`。

## 4. 发布后核对（必做，不要只看 run 是绿的）

```bash
# 桌面
gh release view aichat-rust-v<ver> --json body --jq .body | head -12
for t in darwin-universal win32-x64 win32-arm64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/aichat-rust/$t/latest-client.json"
done
for f in x64-setup.exe arm64-setup.exe universal.dmg; do
  curl -s -o /dev/null -w "%{http_code}\n" -r 0-0 \
    "https://cdn.keepwork.com/keepwork/aichat-rust/<ver>/Keepwork_<ver>_$f"
done

# MCP：三个 feed 的 version/commit/sha256 必须与归档一致
for t in macos-arm64 windows-x64 linux-x64; do
  curl -fsSL "https://cdn.keepwork.com/keepwork/mcp-stable-rs/$t.json"
done
curl -fsSL "https://cdn.keepwork.com/keepwork/mcp-stable-rs/<ver>/<target>.zip" | shasum -a 256
```

同时确认旧版本归档仍然 200（不可变归档不能被覆盖）。

## 5. 已知坑

- **更新清单缓存**：桌面检查更新会给 feed 加一次性 query 参数。测试里写死
  `request.starts_with("GET /latest-client.json ")` 的 fixture 会全部失败，要按 path 比较，忽略 query。
- **MCP `--build-info`**：输出的记录必须与打包侧 `readBuildInfo()` 解析出的记录完全一致。
  嵌入了 `builtAtUnix` 就要同时输出派生出的 `builtAt`，否则契约测试的 `deepEqual` 永远不等。
- **Windows 路径**：Rust 会返回 `\\?\C:\` 与大小写统一的路径，Node 参考实现给的是原始大小写。
  契约测试要用 `canonicalAgentRoot()` 之类做归一，否则只在 Windows 上挂。
- **report.runtime 为 null**：`collect` 已改为从产物 zip 读取运行时身份；历史产物没有该字段时，
  以 `collectRelease` 的二进制嵌入身份校验为准。
- **`[skip publish]`**：普通提交带上它，避免 push 触发 node runtime 发布；发版提交按仓库存量习惯处理。
- **分支分叉**：桌面自动更新线与 main 在 `updates.rs`/`terminal.rs`/`runtime.rs` 上差异很大，
  强行整分支合并会有二十来个冲突。只移植真正需要的修复（路径规范化、构建身份、测试夹具），
  移植后把版本文件保持为本次发布版本，不要带入对方的版本号。

## 6. 产物与留痕

- MCP 手工补发时，把发布计划与回执写到 `.test-runtime/` 下（记录 archive sha256、feed 字节、
  以及被跳过的门禁），不要只留一句"已发布"。
- 任何"验收 pending 但仍发布"的记录都必须在回执和 Job Summary 里显式写明，不能伪装成完整验收。

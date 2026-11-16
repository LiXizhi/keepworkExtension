# Rust 产品发布包验收与持久证据

适用于 `apps/aichat-rust`（桌面）和 `apps/mcp-rust`（独立运行时）。当前功能范围统一见 [能力矩阵](../rust-capability-matrix.md)，协议见 [迁移契约](../rust-runtime-migration.md)。本文定义待执行步骤，不代表任何版本已经通过真机、账号或发布验收。

## 证据格式

每个产品/版本/平台/架构创建一份 JSON 回执，遵循 [rust-release-evidence.schema.json](rust-release-evidence.schema.json)。例如保存为 `docs/acceptance/runs/<product>-<version>-<platform>-<arch>-<UTC>.json`，原始日志、TAP、截图与系统签名输出放同一目录，提交前脱敏。需要长期保留的记录不能只链接 `/tmp` 中的文件。CI 应归档原始测试输出及回执；CI 摘要不代替最终包真机验证。

必填身份包括 `product`、源码 `version/commit`、执行机 `platform/arch`、`recordedAt`。`sourceDirty` 如为true表示检查的是含本地修改的工作树，commit不能单独复现该报告；应同时归档补丁/构建来源。未打包时 `artifact: null`；未探测/启动隔离运行时为 `runtime: null`；未加载网页为 `web: null`。未知身份用 `null`，不能填成当前源码值。`runtime.source: "build-info"` 只证明二进制编译身份，`"health"` 才说明监听服务的实际身份；记录两者时分别建立证据条目。网页只保存 origin 和可确认的 build，不保存登录 URL query/hash、Cookie、Bearer、owner 原值或账号私密内容。

`checks[]` 每项含稳定 `id`、`level`、`status`、`evidence`。实际通过必须附证据路径；未执行保持 `pending`，环境阻止为 `blocked`，明确不适用才用 `skipped`，这些状态及失败均写 `reason`。真实账号、硬件、干净机、桌面会话等条件写入 `requirements`。`overallStatus: passed` 只允许清单内所有项目确实通过；保留 pending 项的源码报告不能作为发布包验收通过证明。

并行开发时，顶层 `sourceHash` 标识本报告所验证的产品源码、共享模块、编译配置与相关测试输入；每个 `checks[].sourceHash` 必须与该快照一致才能复用通过结果。`run` 在命令前后比较指纹，执行期间源码变化则不得记录该快照通过；后续修改需要用新的证据目录重新执行受影响检查。相同Git commit或版本号不能证明未提交工作树相同，不能把不同源码指纹的旧日志合并成一次全绿。

桌面源码指纹及源码快照归档精确排除 `.gitignore` 标为生成产物的 `apps/aichat-rust/releases/`；历史.app/DMG的字节、数量或大小不属于源码输入，不应使同源码产生不同指纹。不将任意同名 `releases` 目录一并排除，真实源码、清单、编译配置与测试输入继续参与验证。最终安装包不因此失去校验：仍在 `artifact` 独立记录并验证实际文件大小与SHA-256。此前包含历史产物的报告/快照保留原始字节、指纹和状态；调整指纹范围后使用新的证据目录重新验证，不改写旧report、不把既有失败或pending重新标为通过。

`checks[].evidenceSha256` 以证据相对路径为键保存各日志/产物的SHA-256，`verify` 同时核对文件存在与实际摘要；自动聚合的gate继承子项指纹和摘要。旧人工回执缺少这些新增字段时保留格式兼容，但不能据此证明与新源码一致；发布级 `--require-complete` 还要求完整源码指纹、所有必要检查完成、最终artifact/runtime身份以及 `sourceDirty: false`。源码/夹具报告可诚实保留dirty与pending，不通过修改状态或删除待验项来获得发布结论。`--metadata-only` 只检查元数据，不验证本地证据字节，不能代替默认verify。

证据入口为仓库根目录的 `scripts/rust-validation-evidence.cjs`。`run` 直接使用参数数组执行命令、保存原始日志与独立check记录并传播退出码；不使用shell拼接。ID采用固定gate或其子项前缀。`collect` 合并记录，缺少的发布gate自动补pending；可显式传最终 `--artifact`，默认不检查共享服务。`verify` 校验格式、证据存在及状态；加 `--require-complete` 才要求没有未完成项。

```sh
node scripts/rust-validation-evidence.cjs run --product aichat-rust --id source-checks-typecheck --level source --output .test-runtime/rust-validation/aichat-rust -- pnpm --prefix apps/aichat-rust typecheck
node scripts/rust-validation-evidence.cjs collect --product aichat-rust --output .test-runtime/rust-validation/aichat-rust
node scripts/rust-validation-evidence.cjs verify .test-runtime/rust-validation/aichat-rust/report.json
```

真实原生/人工验收可按schema在输出目录 `checks/` 保存check记录后再次collect，附实际环境、操作与证据；不能把同一源码命令改level就当成硬件验收。收集器不为了补齐信息重启/替换共享8089、登录账号、发送消息、激活设备或更改前台内容。所有未执行的真实步骤保留在待办回执中，不从命令退出码或HTTP 200推断业务成功。

## 自动化基线

根据改动执行相关用例，并保留原始命令、退出状态和日志。以下是入口，不表示本轮已运行：

```sh
npm run check:shared
pnpm --prefix apps/aichat-rust check
cargo fmt --all --check --manifest-path apps/mcp-rust/Cargo.toml
cargo clippy --manifest-path apps/mcp-rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/mcp-rust/Cargo.toml
node --test scripts/contract/*.test.cjs
```

双引擎对拍必须记录 Node 参考是否实际构建并执行；某引擎被跳过时不能称“双引擎全通过”。受沙盒阻止的回环监听也不能转计为产品失败或已通过。Windows 原生模块的交叉 `cargo check` 不代替 Windows 程序链接、最终安装包和真实输入。原生测试创建的隔离窗口、模拟音轨和 fake CLI 与真实账号/硬件分别记录。

## 桌面最终包清单

每个实际发布目标分别验收：macOS Apple Silicon、macOS Intel、Windows x64、Windows ARM64。Universal DMG 仍需分别验证两种 Mac；没有硬件时记录 pending。Linux 没有本次发布产物时不得加入“已交付三平台”声明。CEF 是单独兼容通道，按 [CEF 验证](../../apps/aichat-rust/docs/windows-cef.md) 记录，不能借用正常 WebView2 的通过结论。

| ID | 层级与条件 | 操作与通过标准 |
| --- | --- | --- |
| `source-checks` | source | 对应版本的编译/共享/布局检查通过，四处桌面版本或 Rust daemon Cargo 版本一致 |
| `fixture-contracts` | fixture | 相关 IPC/HTTP/流/审批/取消/安全回归通过；记录跳过项和新旧组合，不仅写用例总数 |
| `package-integrity` | packaged | 下载最终DMG/EXE；核对文件名、大小、SHA-256、目标架构、内嵌桌面/MCP `--build-info`；记录mac签名/公证/Gatekeeper或Windows Authenticode/发布者/SmartScreen实际状态 |
| `clean-install` | packaged，clean-machine | 在无Keepwork/Node/编辑器的干净测试用户或机器安装，保持系统默认安全设置；检查快捷方式、权限提示、首启及单实例；不以已有开发环境代替 |
| `launch-protocol` | packaged，interactive-desktop | 浏览器 `keepwork-secondbrain://open` 唤回现有窗口；`onboarding` 在冷/热启动都能进入向导；重复点击仅一个意图；取消系统提示仍可下载/重试；非法URL不执行命令/传入目录 |
| `first-paint` | native / packaged | 亮色、暗色、无偏好以及SDK慢/失败，记录首个可见帧和恢复页；不串改网页偏好；加载完成不重开向导/重发消息 |
| `desktop-health` | packaged | 实际8089 identity/engine/owner/capabilities与所连接服务一致；区分当前安装、正在运行、远端可用和源码身份；与既有外部owner共存，不误杀冲突服务 |
| `persona-live` | live，real-account | 使用测试账号登录最终桌面，核对分身列表；在独立临时大脑写入随机验收暗号，提问不包含暗号，真实模型返回准确来源；保留脱敏结果，重启后绑定/历史仍在 |
| `files-terminal` | packaged，interactive-desktop | 独立目录授权、读取/编辑、撤销、路径/软链边界、中文/emoji PTY输出与中断；拒绝与失败不误报成功；关闭主窗保留会话 |
| `runtime-update-rollback` | packaged | 隔离配置执行同引擎升级、下载中断、摘要/目标/引擎/版本错误、健康失败回滚；普通启动仅采用严格较新pending，同版不同commit仅显式apply，旧引擎历史候选不能覆盖显式选择；外部owner只暂存且不终止，缺少peer元数据保持未知；未知任务不重放，回滚后已确认数据可读 |
| `compatibility-matrix` | fixture + packaged | 新桌面/旧网页/旧运行时、新网页/旧桌面、新旧Node/Rust与新新；含可选字段缺失/未知、404/422、重连和downgrade。不能宣称每个已发布版本都实连过 |
| `native-interaction` | native / live，interactive-desktop、real-hardware | 桌宠失焦首击、单/双/右击、透明区穿透、混合DPI跨屏/热拔插、菜单键盘操作；麦克风/剪贴板允许/拒绝/撤销。遥控器PTT/清除/发送/断连/睡眠唤醒只在实际硬件执行后通过，不以一次系统Enter表示业务提交成功 |
| `clean-uninstall` | packaged，clean-machine | 升级/降级/卸载不删除用户大脑、草稿和授权数据；完全退出释放自有设备/进程；未知外部服务保持运行；记录系统协议和快捷方式处理 |

包签名状态、系统确认与真实业务是独立结果。签名不代表没有系统提示，CDN可下载不代表安装成功，网页登录不代表大脑知识问答通过。账号/设备暂不可用时保留相应待验项，继续完成其它验证。

## 独立 MCP 最终包清单

除 `source-checks`、`fixture-contracts`、`package-integrity`、`runtime-update-rollback`、`compatibility-matrix` 外，`mcp-rust` 回执需包含以下项目。测试使用独立 HOME/profile/root和随机回环端口；不为验收自动接管真实共享8089。

| ID | 层级与条件 | 操作与通过标准 |
| --- | --- | --- |
| `runtime-live-identity` | packaged | 从最终归档启动隔离进程，校验清单、`--build-info`、health、握手、Origin/auth、端口冲突attach和退出清理；不修改编译身份环境变量制造新版本 |
| `cli-live` | live，real-account | 逐个实际承诺支持的provider，用真实已授权CLI完成文本、一次文件工具读取、同线程回忆、停止与显式继续；图片能力另验。仅检测安装/目录/登录/握手不能算发言通过 |
| `messaging-live` | live，real-account | 使用明确授权的测试账号/群，检验钉钉/飞书连接、监听、真实人工回复与回执、不确定发送不重放、断连/重启保留收件箱；未授权发送时此项pending。平台操作范围不能超出本版已实现能力 |

测试环境、provider/model、网页build、MCP运行身份和实际安装包必须同一回执可追溯。真实provider不可用不是自动换provider/Node的授权；记录局部不支持或阻塞，普通聊天/其它功能继续验收。

# 客户端安装、唤起与首次使用

2026-11-09：桌面源码版本 0.1.8。本轮接入独立桌面客户端；KP Local Helper、VSIX 和 MCP 协议版本不随桌面版本升级。实现及自动检查与安装包发布、系统协议注册验收、真实模型首问分别记录。

## 用户入口

- Windows x64：下载 EXE，当前用户一键安装，完成后启动；保留快捷方式和已有用户数据。
- macOS arm64 / x64：下载对应 DMG，拖入“应用程序”再打开。系统确认与权限提示由用户处理。
- 网页“打开客户端”使用 `keepwork-secondbrain://open`；“建立第二大脑”使用 `keepwork-secondbrain://onboarding`。仅这两个地址（允许末尾 `/`）有效，不接收 query、fragment、路径、凭据或命令。
- 普通启动恢复当前窗口；首次尚未绑定大脑时提供现有向导。用户可关闭向导，下一次普通启动不会强制重开；明确的 onboarding 入口仍可打开/恢复它。
- 网页不会用 MCP health 推断应用未安装或窗口已打开。唤起五秒后仅提示“未确认客户端已打开”，保持下载、说明和重试入口。浏览器可能阻止自动唤起或要求系统确认。

## 边界及接口

主进程接收 Windows 启动参数/`second-instance` 与 Mac `open-url`，保留待处理意图直到可信 AIChat 主框架确认。单实例锁保持不变。桌面桥 `aichat-desktop:v1` 可选能力 `launchIntents: true` 新增：

- `getLaunchIntent()`：标记当前可信主页面已就绪，读取 `{id, kind}` 或 `null`；kind 是 `first-launch` / `onboarding`。
- `onLaunchIntent(callback)`：通知页面重新读取，返回取消订阅函数；通知不携带外部数据。
- `acknowledgeLaunchIntent(id)`：仅匹配当前意图的 ID 才消费，并保存本机“已提供首次引导”标记。

网页先加载账号资料和原有向导，再订阅/读取。重复请求合并；打开失败不确认，不自动重放业务操作。旧网页可忽略此能力，旧客户端仍能手动打开向导。

本地准备页使用单独受限 IPC，没有文件、终端或聊天桥。MCP 检查复用 RuntimeSupervisor 的身份、能力、单例及进程所有权处理；它通过后才连接 AIChat。失败分别显示 MCP / 网页原因，可重试或打开固定 loopback Dashboard。用户数据、目录授权、账号令牌不进入协议 URL。

## 下载与发布

`latest-client.json` 的根 `format: zip`、`url`、`fileName`、size/SHA-256 保持兼容。可选 `installer` 为 `{format: "exe" | "dmg", fileName, url, size, sha256}`。安装文件必须与 ZIP 的版本/架构同名；新网页优先选有效 installer，缺失/无效的可选 installer 回退到原有合法 ZIP，不按软件版本拒绝连接。

Mac 同时保留 ZIP 更新流。DMG `writeUpdateInfo: false`，不生成依赖其盖票前字节的 updater 元数据或 blockmap。正式 CI 对应用执行签名/公证验证，对 DMG 依次签名、提交公证、盖票、验证，然后生成最终 provenance SHA-256。安装文件上传并验证完成后才提升清单。

正式 Mac 发布/发布质量构建缺少 Apple 签名及公证凭据时失败；普通内部构建标为 ad-hoc，公开本地发布器拒绝此类产物。Windows provenance 记录 Authenticode 状态/发布者；SmartScreen 与干净机结果保持 pending，直到原生验收。任何签名都不自动代表没有系统提示。

## 自动检查

在 keepworkExtension 根目录：

```sh
npm run check:shared
npm run check --prefix apps/aichat-desktop
node --test scripts/publish-desktop.test.cjs scripts/publish-desktop-artifacts.test.cjs scripts/qiniu-release.test.cjs
node apps/aichat-desktop/scripts/launch-smoke.cjs
```

Electron smoke 使用临时 profile、本地 fixture、禁用真实 MCP，不注册生产系统协议或修改已安装应用；验证冷启动意图、平台事件、聚焦、确认/重载、iframe 隔离、准备页失败与重试。它不证明 Windows 系统注册/安装或 Mac Gatekeeper 通过。

AIChat 定向 Node 与浏览器检查见其 `tests/unit/desktop_launch.test.mjs`、`tests/client_download.test.mjs` 和 `tests/e2e/desktop_launch.test.mjs`。浏览器使用真实向导、隔离 SDK/下载清单；外部导航被替换为记录器，避免唤起用户已安装客户端。不得将其当成真实模型验收。

## 原生交付

逐项执行 [Windows 验收](acceptance/desktop-first-use-win.md) 和 [Mac 验收](acceptance/desktop-first-use-mac.md)。桌面侧交付安装/协议/启动证据，工作台侧交付向导和真实知识问答证据。未执行项保持“待验收”；失败附日志与缺陷记录，不用页面可访问或 HTTP 200 替代业务完成。

## 2026-11-09 本地验证结果

- 共享 TypeScript/目录布局/运行时同步检查通过；桌面检查 90/90、网页定向 Node 检查 46/46、发布器检查 12/12 通过。
- 浏览器用例串行执行 9/9 通过，覆盖真实向导界面、协议入口、Mac 架构切换、安装文件选择和失败重试。并行运行曾出现 fixture 初始化 fetch/等待超时，尚未定位，未据此宣称并行环境稳定。
- 临时 profile 的真实 Electron 唤起 smoke 与捆绑 MCP 0.1.34 runtime smoke 通过；系统协议注册和真实模型均未参与这些检查。
- 已生成本地 Mac arm64 0.1.8 DMG 与 ZIP，严格 ad-hoc 签名、DMG 校验和、ZIP 完整性、Info.plist 版本/协议声明、包内主进程及准备页字节一致性通过。最终大小、SHA-256、宿主系统及待验收项见 [本地回执](acceptance/desktop-first-use-local-20261109.json)。这是未公证的内部包，未上传 CDN。
- 源码未提交/推送，网页未发布；Windows x64、Mac arm64/x64 干净机、正式签名/公证与真实账号模型问答仍待执行。

## 2026-11-09 内部试装包交付

为本轮试装创建并推送独立源码快照 `c93a1d13ddbe014192efb74ee7d936ffe1719082`，分支 `codex/desktop-0-1-8-internal-20261109`；未合并主分支，原工作树与暂存区保持。CI 未执行 CDN 发布。

已交付本机 Mac Apple Silicon DMG 和原生 Windows CI 的 x64 EXE，均为 0.1.8、捆绑 MCP 0.1.34。Windows 重试后桌面 90 项、原生 PTY、MCP/本地模型 runtime smoke 通过，下载产物与 provenance/更新清单校验一致，包内版本/协议/桥/准备页及 x64 PE 已检查。Windows 实际签名为 NotSigned；Mac 仍是未公证 ad-hoc 包。安装与真实业务验收继续待执行。

完整文件路径、SHA-256、CI 地址与签名状态见 [内部试装回执](acceptance/desktop-internal-build-20261109.json)。交付目录为 `/Users/chx/Desktop/sz-run/KeepWork-0.1.8-试用包`。Intel CI 在打包阶段遇到上游 504，未交付 Intel 包；因此 CI 整体显示失败，Windows/arm64 子任务分别成功。网页改动未发布，现有线上向导可手动使用，新增网页入口与意图消费需配套网页上线。

## Mac 自动语言修复 0.1.9

用户试装 0.1.8 后发现设置、输入区等显示英文。实机设置为 System default，macOS 首选语言为 `zh-Hans-CN`，已安装应用的 Chromium 却使用 `en-US`。打包移除了应用根目录的空 `.lproj` 目录，且 Info.plist 没有 `CFBundleLocalizations`，AppKit 因而回退英语；开发 Electron 保留这些目录，不能用开发版的正常语言推断安装包正常。

0.1.9 在 Mac Info.plist 声明 `zh-Hans`、`zh-Hant`、`en`，不改网页优先级或用户手动偏好。原生回归命令为 `node apps/aichat-desktop/scripts/locale-smoke.cjs [已打包应用路径]`；CI 对最终 Mac 应用执行此检查。它克隆应用并替换克隆的业务入口，保留引擎/Helper/语言元数据，避免启动真实 MCP 或读取用户数据。

同一命令对旧 0.1.8 包的中文场景失败；对新 0.1.9 包的中文、英文场景通过。桌面检查 90 项通过，签名/DMG/ZIP 完整性检查通过。网页语言优先级和 SDK 语言两项通过；旁支的目录翻译检查仍因缺少“圈子”英文翻译失败，HEAD 字典也缺失此键，本轮未修改该字典。

Mac arm64 新包及哈希见 [语言修复回执](acceptance/desktop-mac-locale-20261109.json)，交付目录 `/Users/chx/Desktop/sz-run/KeepWork-0.1.9-试用包`；仍为未公证内部包，未替换用户正在运行的应用。旧版也可通过 Settings → General → Language → 简体中文立即切换。Windows 0.1.8 不受该 Mac 打包缺陷影响，网页未发布。

# Mac 干净机安装到真实首问

## 分架构回执

| 项目 | Apple Silicon arm64 | Intel x64 |
| --- | --- | --- |
| 状态 | 待干净机原生验收 | 待干净机原生验收 |
| 系统版本/CPU | 待填 | 待填 |
| 客户端/安装包版本 | 源码 0.1.8；正式发布包待填 | 源码 0.1.8；正式发布包待填 |
| DMG URL / SHA-256 | 待填 | 待填 |
| Developer ID / 公证 / 票据 | 待正式包核验 | 待正式包核验 |
| MCP runtimeVersion / runtimeCommit | 待填 | 待填 |
| 网页发布标识 | 待填 | 待填 |
| 测试时间/执行人/证据目录 | 待填 | 待填 |

本地 ad-hoc 包只供内部检查，不作为 Developer ID、公证或 Gatekeeper 通过证据。桌面源码构建、Electron smoke 和本机已有环境均不替代以上两列。

## 步骤

1. 每种架构使用新的测试机/用户，无 KeepWork、Node、VS Code，保持系统默认安全设置。
2. 网页下载时确认 Apple Silicon / Intel；切换芯片后下载链接应改变。核对 DMG 与最终 provenance SHA-256。
3. 打开 DMG，拖入“应用程序”后打开，记录系统确认。正式包检查应用 codesign、Gatekeeper 以及应用/DMG 的公证票据；不要以移除 quarantine 或关闭系统安全功能作为通过条件。
4. 观察准备页，读取 loopback `/health`，核对 Keepwork 服务身份及所需能力、MCP runtimeVersion/runtimeCommit。记录客户端实际应用版本，不能取 MCP 协议版本代替。
5. 客户端后台和完全退出两种状态下，从网页分别点击“打开客户端”和“建立第二大脑”；连续点击确认单实例、单向导，普通打开保留当前工作。取消系统确认后仍能下载和重试。
6. 参照 [Windows 真实首问步骤 5–8](desktop-first-use-win.md) 使用测试账号、内置 AIChat、独立大脑与随机暗号资料，完成创建、整理、首问、来源核对和重启读取。每种架构分别记录真实模型结果。
7. 验证离线重试、端口冲突、取消授权、旧客户端/旧 MCP 兼容、覆盖升级保留用户数据。若额外验证音视频，分开记录系统权限与应用内权限，不作为文本首问的替代。

## 缺陷表

| 编号 | 环节/复现步骤 | 预期/实际 | 版本/证据 | 处理状态 |
| --- | --- | --- | --- | --- |
| MAC-ARM64-ACCEPTANCE-PENDING | 尚无干净机执行记录 | 等待正式签名包和完整步骤 | 待填 | 待验收 |
| MAC-X64-ACCEPTANCE-PENDING | 尚无 Intel 执行记录 | 等待正式签名包和完整步骤 | 待填 | 待验收 |

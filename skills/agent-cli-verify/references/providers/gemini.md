# Antigravity CLI CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`gemini`。
官方来源：[Antigravity CLI](https://antigravity.google/docs/cli/install/)；核对日期：2026-10-14。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：从 `https://antigravity.google/cli/install.ps1` 下载临时脚本，检查当前官方内容后用 PowerShell 执行。证据：documented。
- macOS：从 `https://antigravity.google/cli/install.sh` 下载临时脚本，检查当前官方内容后用 bash 执行。证据：documented。
- 版本：`agy --version`。
- 登录：`agy`，由用户完成授权，不读取或复制凭据。

- 替代 Gemini CLI；保留后端 gemini 作为历史数据键。安装和运行使用 agy，不再安装 @google/gemini-cli。
- Windows 默认路径为 %LOCALAPPDATA%/agy/bin/agy.exe；macOS 为 ~/.local/bin/agy。可用 KEEPWORK_ANTIGRAVITY_PATH 指定，不复用旧 KEEPWORK_GEMINI_PATH。
- 使用原生 stream-json 协议，不是 ACP。无交互模式不能回复权限请求，遵守原生权限配置；不会自动添加全局允许规则。
- 已有 Gemini CLI 对话仅保留可读历史，继续工作需新建 Antigravity 对话；凭据交由 agy 原生登录和系统密钥环管理。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

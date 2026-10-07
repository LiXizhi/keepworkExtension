# Claude Code CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`claude`。
官方来源：[Claude Code](https://code.claude.com/docs/en/setup)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：从 `https://claude.ai/install.ps1` 下载临时脚本，检查当前官方内容后用 PowerShell 执行。证据：documented。
- macOS：从 `https://claude.ai/install.sh` 下载临时脚本，检查当前官方内容后用 bash 执行。证据：documented。
- 版本：`claude --version`。
- 登录：`claude auth login`，由用户完成授权，不读取或复制凭据。

- 官方优先原生安装；npm 是兼容备选。保留用户的 release channel 和组织策略，不使用绕过权限的启动参数。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

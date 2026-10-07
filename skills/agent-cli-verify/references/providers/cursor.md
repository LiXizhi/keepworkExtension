# Cursor CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`cursor`。
官方来源：[Cursor](https://cursor.com/docs/cli/installation)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：从 `https://cursor.com/install?win32=true` 下载临时脚本，检查当前官方内容后用 Windows PowerShell 5.1 执行。证据：native-install-verified。
- macOS：从 `https://cursor.com/install` 下载临时脚本，检查当前官方内容后用 bash 执行。证据：documented。
- 版本：`cursor-agent --version`。
- 登录：`agent login`，由用户完成授权，不读取或复制凭据。

- 桌面 Cursor 不等于 Agent CLI；Windows 官方包装器需解析 dated versions 目录中的 bundled node.exe/index.js，不能假设顶层 EXE。
- 安装器可能重建 CLI 目录；已有可用安装优先复用。当前安装后 ACP initialize 已验证，尚未登录，模型/真实生成待验证。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

# OpenCode CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`opencode`。
官方来源：[OpenCode](https://opencode.ai/docs/)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g opencode-ai`。证据：documented。
- macOS：运行 `npm install -g opencode-ai`。证据：documented。
- 版本：`opencode --version`。
- 登录：`opencode auth login`，由用户完成授权，不读取或复制凭据。

- Windows 官方推荐 WSL，原生 npm 也是官方方法。Keepwork 守护进程默认在本机系统运行，不把 WSL 内的 CLI 路径当作 Windows EXE。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

# Kimi CLI CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`kimi`。
官方来源：[Kimi CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g @moonshot-ai/kimi-code`。证据：documented。
- macOS：运行 `npm install -g @moonshot-ai/kimi-code`。证据：documented。
- 版本：`kimi --version`。
- 登录：`kimi login`，由用户完成授权，不读取或复制凭据。

- 当前 TypeScript/npm Kimi Code 与旧 Python kimi-cli 分开，当前 npm 路径要求 Node >=22.19.0；Windows 需要 Git Bash。核对迁移说明，不能误升级到另一种实现。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

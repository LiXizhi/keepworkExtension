# Codex CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`codex`。
官方来源：[Codex](https://developers.openai.com/codex/cli/)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g @openai/codex`。证据：documented。
- macOS：运行 `npm install -g @openai/codex`。证据：documented。
- 版本：`codex --version`。
- 登录：`codex login`，由用户完成授权，不读取或复制凭据。

- 原生 app-server 常驻复用；模型和 thinking effort 由 model/list 返回，不从静态版本表猜测。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

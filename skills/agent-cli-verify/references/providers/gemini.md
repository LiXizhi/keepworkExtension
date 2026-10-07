# Gemini CLI CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`gemini`。
官方来源：[Gemini CLI](https://geminicli.com/docs/get-started/installation/)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g @google/gemini-cli`。证据：documented。
- macOS：运行 `npm install -g @google/gemini-cli`。证据：documented。
- 版本：`gemini --version`。
- 登录：`gemini`，由用户完成授权，不读取或复制凭据。

- 使用稳定 latest 通道，不把 preview/nightly 当作普通升级。模型切换与原生 --experimental-acp 参数需随官方 CLI 版本核验。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

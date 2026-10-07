# Qwen Code CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`qwen`。
官方来源：[Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g @qwen-code/qwen-code`。证据：documented。
- macOS：运行 `npm install -g @qwen-code/qwen-code`。证据：documented。
- 版本：`qwen --version`。
- 登录：`qwen`，由用户完成授权，不读取或复制凭据。

- 当前 npm 安装要求 Node >=22。首次启动选择认证方式，已有凭据应复用；模型和思考选项以原生协议为准。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

# WorkBuddy CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`workbuddy`。
官方来源：[WorkBuddy](https://www.codebuddy.cn/docs/cli/installation)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g @tencent-ai/codebuddy-code`。证据：native-install-verified。
- macOS：运行 `npm install -g @tencent-ai/codebuddy-code`。证据：documented。
- 版本：`codebuddy --version`。
- 登录：`codebuddy /login`，由用户完成授权，不读取或复制凭据。

- 两种平台共享官方 CodeBuddy ACP 引擎，桌面 WorkBuddy 登录不保证 CLI 已登录。优先发现桌面 bundle；缺少登录模块时使用官方独立 CLI。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

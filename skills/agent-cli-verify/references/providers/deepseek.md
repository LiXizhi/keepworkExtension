# DeepSeek Harness CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`deepseek`。
官方来源：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；核对日期：2026-11-05。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `npm install -g @deepseek-ai/dsh`。证据：official npm package; not live-tested。
- macOS：运行 `npm install -g @deepseek-ai/dsh`。证据：official npm package; not live-tested。
- 版本：`dsh --version`。
- 登录：`dsh web`，由用户完成授权，不读取或复制凭据。

- 使用官方 dsh --profile acp；模型和能力来自 ACP 握手，不预设模型。
- dsh web 打开本机配置界面，由用户完成模型提供商配置；这不是 dsh login，勿虚构登录或退出命令。配置后重新检测 ACP。
- 需要满足官方 npm 包的 Node.js engines 要求。未进行 Windows/macOS 真实生成验收。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

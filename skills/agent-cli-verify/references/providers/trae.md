# Trae Agent CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`trae`。
官方来源：[Trae Agent](https://github.com/bytedance/trae-agent)；核对日期：2026-11-14。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：运行 `uv tool install --python 3.12 git+https://github.com/bytedance/trae-agent.git`。证据：documented-package-install。
- macOS：运行 `uv tool install --python 3.12 git+https://github.com/bytedance/trae-agent.git`。证据：documented-package-install。
- 版本：`trae-cli --version`。
- 配置帮助（无登录/注销）：`trae-cli --help`，由用户按上游示例配置模型服务；此命令不验证凭据。

- 开源 bytedance/trae-agent 使用 Python >=3.12、Git 和 uv；先检查前提。此 uv tool 配方依据上游 Python 包入口与 uv 官方工具安装文档组合，尚未实机安装验收；上游源码方式为 git clone 后 uv sync --all-extras。
- 只发现 trae-cli；TRAE IDE、企业 TraeCode CLI 的 traecli/traex 不是本后端。无需 TRAE 企业账号，所选模型服务的 API 使用条件由模型服务决定。
- 没有网页登录或 logout 命令；trae-cli --help 仅显示帮助。由用户按上游示例配置 trae_config.yaml 和模型服务凭据，或设置绝对 TRAE_CONFIG_FILE；不读取、复制或输出配置/密钥。
- 原生 run 每轮是独立任务，不支持 ACP、原生续聊/历史导入、AIChat 网页工具、Ask/Plan、图片或思考强度。仅 Craft 本地工作区；AIChat 保留可读文本记录，不自动重放此前任务。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

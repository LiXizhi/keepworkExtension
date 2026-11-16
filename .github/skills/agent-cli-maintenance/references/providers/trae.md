# Trae Agent CLI 维护参考

后端 ID：`trae`。官方安装来源：[Trae Agent](https://github.com/bytedance/trae-agent)。
安装说明最后人工核对：2026-11-14；该日期不代表所有系统的真实运行通过。

先读现有 CLI 路径和版本，复用可用安装。用户要求安装/更新本平台时，
通过已提供的 Keepwork `run_terminal` 和现有确认流程操作本机；检查请求
本身不安装其他平台。没有本机工具时说明前提，不声称浏览器已经执行。

## 安装与更新

- Windows：运行 `uv tool install --python 3.12 git+https://github.com/bytedance/trae-agent.git`。证据：documented-package-install。
- macOS：运行 `uv tool install --python 3.12 git+https://github.com/bytedance/trae-agent.git`。证据：documented-package-install。
- 检查版本：`trae-cli --version`；安装后旧 GUI PATH 可能尚未刷新，
  先检查常见安装目录，不为此重复安装。
- 配置入口（仅帮助，无登录/注销）：`trae-cli --help`。按上游示例由用户配置模型服务；此命令不验证凭据。
- 更新：`uv tool upgrade trae-agent`，仍需确认当前官方方法与原有安装渠道一致。

- 开源 bytedance/trae-agent 使用 Python >=3.12、Git 和 uv；先检查前提。此 uv tool 配方依据上游 Python 包入口与 uv 官方工具安装文档组合，尚未实机安装验收；上游源码方式为 git clone 后 uv sync --all-extras。
- 只发现 trae-cli；TRAE IDE、企业 TraeCode CLI 的 traecli/traex 不是本后端。无需 TRAE 企业账号，所选模型服务的 API 使用条件由模型服务决定。
- 没有网页登录或 logout 命令；trae-cli --help 仅显示帮助。由用户按上游示例配置 trae_config.yaml 和模型服务凭据，或设置绝对 TRAE_CONFIG_FILE；不读取、复制或输出配置/密钥。
- 原生 run 每轮是独立任务，不支持 ACP、原生续聊/历史导入、AIChat 网页工具、Ask/Plan、图片或思考强度。仅 Craft 本地工作区；AIChat 保留可读文本记录，不自动重放此前任务。

## 维护验证

原生协议：`trae`；注册的命令候选：`trae-cli`；
原生参数：`由 Trae run adapter 构造`。
定期核对官方发布说明、安装脚本和协议变化。更新安装参考与源码注册表后，
重新同步 AIChat/MCP Skill，并运行对应发现、协议和浏览器回归。

分别记录：文档核对、CLI 版本/路径、握手、原生模型/思考选项、真实工具与
两轮继续、断线重连。所有者和业务工作区必须隔离；常驻进程和能力可复用。
模型 ID/选项不能静态猜测，原生未提供的思考选项保持禁用。
未安装、未登录、未测试、超时都不能记作通过；不自动重放不确定的请求。
真实验证使用两处临时工作区，不修改用户项目。更新前后保留结果，
仅在相关验收通过后推进产品更新；不在本技能中擅自发布产品。

共享验证流程见仓库 `skills/agent-cli-verify/SKILL.md`。
全平台开发流程见 [维护 Skill](../../SKILL.md)。

# Trae CLI 维护参考

后端 ID：`trae`。官方安装来源：[Trae](https://docs.trae.cn/cli_get-started-with-trae-code-cli-2)。
安装说明最后人工核对：2026-10-07；该日期不代表所有系统的真实运行通过。

先读现有 CLI 路径和版本，复用可用安装。用户要求安装/更新本平台时，
通过已提供的 Keepwork `run_terminal` 和现有确认流程操作本机；检查请求
本身不安装其他平台。没有本机工具时说明前提，不声称浏览器已经执行。

## 安装与更新

- Windows：从 `https://trae.cn/trae-cli/install_v2.ps1` 下载临时脚本，检查当前官方内容后用 PowerShell 执行。证据：documented。
- macOS：从 `https://trae.cn/trae-cli/install_v2.sh` 下载临时脚本，检查当前官方内容后用 sh 执行。证据：documented。
- 检查版本：`traecli --version`；安装后旧 GUI PATH 可能尚未刷新，
  先检查常见安装目录，不为此重复安装。
- 登录入口：`traecli`。在用户可见终端让用户完成授权，不复制凭据。
- 更新：`traecli update`，仍需确认当前官方方法与原有安装渠道一致。

- TRAE 桌面版与 TraeCode CLI 2.0 分开；首次运行可能需要账号权限、沙箱初始化和项目受信任设置，不能自动代替用户确认。

## 维护验证

原生协议：`acp`；注册的命令候选：`traecli`、`traex`；
原生参数：`acp serve`。
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

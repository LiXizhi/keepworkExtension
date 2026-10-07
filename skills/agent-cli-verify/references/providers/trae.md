# Trae CLI 安装参考

这是产品运行时安装参考，不是独立 Skill。后端：`trae`。
官方来源：[Trae](https://docs.trae.cn/cli_get-started-with-trae-code-cli-2)；核对日期：2026-10-07。

先查已有 CLI 路径和版本，只安装用户请求的平台。通过 Keepwork run_terminal 和现有确认流程执行；没有本机工具时不声称已安装。

- Windows：从 `https://trae.cn/trae-cli/install_v2.ps1` 下载临时脚本，检查当前官方内容后用 PowerShell 执行。证据：documented。
- macOS：从 `https://trae.cn/trae-cli/install_v2.sh` 下载临时脚本，检查当前官方内容后用 sh 执行。证据：documented。
- 版本：`traecli --version`。
- 登录：`traecli`，由用户完成授权，不读取或复制凭据。

- TRAE 桌面版与 TraeCode CLI 2.0 分开；首次运行可能需要账号权限、沙箱初始化和项目受信任设置，不能自动代替用户确认。

安装后重新检测真实路径，验证握手、原生模型及真实请求；未登录、未测试不能报告通过。旧 GUI PATH 不代表安装丢失。

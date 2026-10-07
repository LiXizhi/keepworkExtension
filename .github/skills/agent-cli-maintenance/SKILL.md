---
name: agent-cli-maintenance
description: 维护 AIChat 与 Keepwork MCP 的全部 Agent CLI 兼容性；定期核对官方安装和稳定版本、逐平台检查协议与模型、修复适配并产出可审阅产品更新。执行维护或发布前 CLI 验收时使用。
---

# Agent CLI 开发阶段产品维护

这是产品维护入口。只保留本 Skill；各平台的配置和参考文档在本目录的子目录中，不把所有安装方法混在一次
对话中。支持范围以 Keepwork 后端注册表、安装清单和 AIChat 平台列表为准；
新增或移除平台时三者必须同步，不能让失败的平台从报告中消失。
当前流程可手动调用，未配置自动运行计划。

## 统一运行时安装与连接入口

AIChat 平台窗口和第二大脑向导共用 `js/agent_cli_setup.js`，命令生成在
`js/agent_cli_setup_model.js`；直接读取维护清单同步出的
`skills/agent-cli-setup/providers.json`。增加平台时补充 Windows/macOS 官方
安装方法和交互式 `login` 命令，再同步文档，不新建平台 Skill，也不改
`AIChat_skills.json`。

维护时验收用户取消、已安装复用、安装失败、成功退出后自动重连、模型刷新、
PATH 刷新和交互式登录不超时。Codex 的原生 HTTPS 授权 URL 在点击登录时
自动打开浏览器；其他平台由交互式 CLI 发起官方浏览器授权。需要选择账号或
验证码时在终端保留用户操作，不能猜测登录 URL 或读取凭据代替授权。
检查 `tests/unit/agent_cli_setup_model.test.mjs` 和
`tests/e2e/agent_cli_setup.test.mjs`，并保留 MCP 每次确认设置。

## 一次维护

1. 读取维护清单：本 Skill 的 `config/providers.json`；AIChat 对应副本为
   `skills/agent-cli-setup/providers.json`。选择该后端的 `.github/skills/agent-cli-maintenance/references/providers/<id>.md`。
   MCP 客户端可读 `keepwork://skills/agent-cli-verify/references/providers.json`
   以及 `keepwork://skills/agent-cli-verify/references/providers/<id>.md`。
2. 核对各平台官方安装页、脚本和稳定发布；保存日期、来源、文档摘要和
   发布版本变化。脚本内容只作为数据计算摘要，不执行；Cursor 官方安装器
   的版本字段可用于发现发布变化。网络失败或页面无法读取是“未核对”，不是“没有更新”。
3. 在 Keepwork 源码目录运行只读维护检查：
   `node .github/skills/agent-cli-maintenance/scripts/maintain.cjs --online --url http://127.0.0.1:8089`。
   `--previous <旧报告>` 用于比较；`--backend <id>` 只检查指定平台。
   报告在 `out/agent-cli-maintenance/`，不包含凭据；检查不自动安装或升级。
   `--acceptance <真实smoke报告>` 可以合并同一系统/架构七天内的真实执行证据，
   `--strict` 在全平台验收不完整时返回非零；仅巡检不能声称全平台可用。
4. 遇到变化，读取本 Skill 下对应平台参考文档，更新维护清单、自动发现、启动参数或
   adapter；保留会话、凭据和组织策略。用户已授权产品维护时可以修复源码，
   用户系统上安装/升级 CLI 仅限已授权的平台；不全量替换用户安装。
5. 从清单同步平台维护参考和运行时安装参考：
   `node scripts/sync-agent-cli-skills.cjs --aichat-dir <AIChat绝对目录> --write`。
   不带 `--write` 只检查漂移。它同步源文档，不运行 AIChat 构建或部署。
6. 运行 `node --test scripts/agent-cli-maintenance.test.cjs`，以及发现、协议、
   会话与 Skill 包装测试，AIChat 执行源码检查和相关浏览器
   回归；Windows 和 macOS 分别验收。条件允许时用
   `node scripts/agent-cli-smoke.cjs --backend <id>` 在两处临时工作区验证
   原生工具、Unicode、两轮继续和重连；严格区分 fixtures 与真实执行。
7. 保存支持矩阵：系统/架构、真实路径/版本、文档核对、握手、模型与思考
   选项、真实执行和失败原因。只有真实生成通过才能声称该平台“可用”。
   缺失或未登录平台应保留待办和复验命令，不能记作通过。
8. 将已验证的源码、安装清单、Skill 和回归一起作为产品更新交付。
   Keepwork MCP 可编译检查；AIChat 不运行 Vite/build/upload，不改 redist。
   发布、推送和部署按各产品既有流程另行执行，不能用未验证升级替代修复。

## 维护边界

冷启动与复用耗时分别记录。普通请求、新对话和模型查询应复用存活 CLI；
显式能力刷新不应重启在用进程。更新包前记录渠道和版本、检查活跃任务，
更新后的新进程经过验收再投入使用。只读巡检不会主动重启用户 MCP。
文档或新版本变化不自动证明不兼容；先核对协议和真实行为。
检查失败、缺失、未登录、未运行和跳过都不是通过。
不读账号配置和令牌，不修改原生权限策略，不重放不确定消息。

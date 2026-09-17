# 10 Keepwork 本地助手：MCP、文件与 Paracraft 桥

本文由 AI 根据第二大脑资料与 Git 源码整理。核对日期：2026-09-17。代码基线：`keepworkExtension` / `main` / `06141674378f`。这是源码快照说明；未据此宣称生产环境已完成全部验收。

## 用户用途

Keepwork Extension 和 KP Local Helper 共用本地服务，使网页 AIChat 能操作本人授权的本机工作空间、终端及 Paracraft 客户端。VS Code/Cursor 扩展与独立桌面助手是不同宿主，共享核心代码，不能彼此引用产品入口。

## 使用流程

1. 安装并启动已认可的扩展或 Local Helper，在 AIChat 的 MCP 连接处查看服务状态。
2. 绑定正确的本地项目文件夹，先让 AI 只读列目录或检索，再执行明确的修改任务。
3. 需要终端时审核命令与工作目录；需要 Paracraft 时先查看已连接客户端与当前世界。
4. 修改后检查文件 diff 或场景结果；服务连接成功不等于任务执行完成。

## 架构

```text
AIChat local_mcp / 文件桥 → 127.0.0.1:8089 单例 daemon
  ├ MCP tools → grep / terminal / web / browser / computer 等注册模块
  ├ /fs/* → 指定 root 下的文件读写
  ├ /terminal/sessions → 用户操作的 PTY 生命周期
  └ /paracraft/* → NPL HTTP 客户端或轮询队列
VS Code 扩展 / Local Helper → 启动、状态、通知与生命周期
```

HTTP 服务在独立进程中，而非直接运行在扩展宿主内。:8089 是本地服务；:8099 起是 NPL 引擎；Maker 的 :18300 是另一条桥。内嵌 WebParaCraft Wiki 通常无需该本地服务。

## 边界与维护

只绑定 loopback；身份和 Origin 校验由 `src/mcp/http.ts` 统一维护。`paths.ts` 与 `fsServe.ts` 处理空间和路径限制。手动 PTY 输入与模型工具 `run_terminal` 的确认策略不同，不可互相替代。

先查 `/health`，再查客户端发现、所选 root 和工具回执。当前 `src/mcp/server.ts` 已注册场景读取等扩展入口，旧“五个 MCP 工具”介绍不是完整清单。电脑控制是受同意与平台约束的能力，不应写成后台无条件操控。

本轮只补充架构说明；没有安装/发布助手、没有运行模型终端任务或修改用户配置。

## 源码与维护入口

- [`src/mcp/server.ts`](https://github.com/LiXizhi/keepworkExtension/blob/06141674378f789aa11c4d1743e9796ff8beb97e/src/mcp/server.ts)
- [`src/mcp/http.ts`](https://github.com/LiXizhi/keepworkExtension/blob/06141674378f789aa11c4d1743e9796ff8beb97e/src/mcp/http.ts)
- [`src/core/paths.ts`](https://github.com/LiXizhi/keepworkExtension/blob/06141674378f789aa11c4d1743e9796ff8beb97e/src/core/paths.ts)
- [`src/core/fsServe.ts`](https://github.com/LiXizhi/keepworkExtension/blob/06141674378f789aa11c4d1743e9796ff8beb97e/src/core/fsServe.ts)
- [`src/core/paracraftClients.ts`](https://github.com/LiXizhi/keepworkExtension/blob/06141674378f789aa11c4d1743e9796ff8beb97e/src/core/paracraftClients.ts)
- [`docs/paracraft-cli.md`](https://github.com/LiXizhi/keepworkExtension/blob/06141674378f789aa11c4d1743e9796ff8beb97e/docs/paracraft-cli.md)

## 钉钉发布版本

[国基知识库中的本篇手册](https://alidocs.dingtalk.com/i/nodes/7QG4Yx2JpnYdlgnpCqkq60mvW9dEq3XD)（2026-09-17）。截图保存在钉钉原文中；后续更新本文件后同步原文档。

# KeepWork 家庭平板

入口：[launcher.html](launcher.html)。无构建依赖，浏览器直接打开即可。

围绕全家的第二大脑，演示家庭登录、新建用户与家庭成员切换（先选孩子／成人／老人，再选家庭称呼或 DIY），以及每人的数字世界、我的数字大脑和个人日历。我的数字大脑固定打开 `https://keepwork.com/chat`。

桌面固定预置微信、抖音、电话、日历、浏览器，没有应用商店、添加应用或安装入口。桌面按屏幕等比适配，不滚动；窄屏通过固定日历图标打开完整个人日历。应用工具栏合并到最上方状态栏。

- [产品规划](docs/product-plan.md)
- [原型交互与接入边界](docs/prototype-design.md)
- 浏览器检查：`node tests/browser-smoke.cjs`。需安装 Playwright 和 Edge；可用 `PLAYWRIGHT_MODULE` 指定 Playwright 模块位置，用 `BROWSER_EXECUTABLE` 指定浏览器。

家庭登录与用户均为演示，不切换真实应用账号。日历仅按角色保存到本机。微信和抖音打开官方网页版；电话在用户主动操作后交给已有拨号器。禁止 Android 安装应用属于后续 OEM／设备管理策略，H5 本身无法提供系统级保证。内嵌应用未授予下载权限，但外部网页与新标签页不受 H5 的安装控制。

2026-10-12 从 `LiXizhiDocs/_draft/keepwork-family-pad` 迁入。此应用独立于扩展、Local Helper 和 MCP，不参与其打包与发布。尚未发布或提交 Git。

用户创建检查：`node tests/profile-creation.cjs`。首次使用无预填角色；旧演示角色与日历保留迁移，用户多时分页展示。成人可选哈奇或人生几何。

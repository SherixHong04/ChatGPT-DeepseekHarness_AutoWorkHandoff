# Work Handoff 共享预览版

版本：0.3.0-beta.3。面向Windows本地桌面环境，提供真实额度检测、任务资料整理工具、DeepSeek Harness副本执行和原GPT对话验收。额度检测后的自动交接仍需模型执行并核对回执，不能将提示发出当成已派发。新增本地现实时间接回程序，已在本机完成一次60秒独立计时、真实额度检查、原对话自动唤醒及身份回执验证；其他用户与客户端版本仍须各自验证。

本包不含开发者的个人路径、配置、聊天、任务数据库、备份或账号信息。每位用户首次使用时生成自己的本机配置；安装不会读取或搬运原作者的运行现场。无需管理员权限，不修改Defender、防火墙、UAC、沙箱或钩子信任记录。

## 先读

- [安装和卸载](docs/INSTALL.md)：生成配置、正常安装Harness插件、审核钩子。
- [使用流程](docs/WORKFLOW.md)：派发、等待、多轮、验收和写回。
- [文件组成](docs/FILES.md)：源码及辅助程序的职责。
- [验证范围与限制](docs/VALIDATION.md)：区分本地模拟通过与新电脑真实实测。
- [共享范围](docs/SHARING.md)：只分享发行包，不能打包用户运行目录。
- [本地计时和接回](docs/LOCAL-WAKE.md)：绝对到期时间、真实额度、忙闲检查和原对话回执；说明未加载宿主的限制。

需要Node.js 24或以上，以及支持原生MCP钩子、get_usage_limits的本地GPT宿主。本地计时需官方Codex CLI与可连接的同一后台；不能仅凭安装CLI保证桌面唤醒。Harness需用户正常登录。本版不承诺任意ChatGPT网页/手机、macOS或Linux兼容。

构建和本地测试（不启动真实模型）：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
npm.cmd run check
npm.cmd run test:local
```

安装前先按docs/INSTALL.md运行setup init和install预览。不要直接将本工程中的占位配置复制到用户全局设置。原生钩子需每位用户正常审核，不能复制其他人的信任记录。

新管理任务已接入正式handoff_dispatch/managed_inspect/managed_collect，不再依赖某条测试会话或维护脚本。用户可在同一Harness聊天继续工作，稳定后再次收取；验收、准备提交及应用提交前均检查聊天和共享文件版本，旧验收不能写回新要求。但程序不强制锁住用户界面，仍有跨进程并发窗口。

发行定位是可交付给其他用户试用的开发预览，尚非跨电脑与真实升级全部验证的稳定发行。不要把本地测试数当作真实模型、额度耗尽恢复或定时接回证据。本次改造不自动迁移或替换已有安装。

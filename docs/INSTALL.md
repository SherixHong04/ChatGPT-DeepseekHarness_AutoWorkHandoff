# 安装、配置及卸载

## 1. 准备

解压到用户可写且两端都能访问的普通目录。安装Node.js 24+，先构建（见README）。工作区和运行数据不能使用联接/符号链接。不要把运行目录放在将被授权收集的输入目录内。

在正常Harness安装目录中找到其自带dsh.cmd。保持现有正常登录，不导出账号或API密钥。

以下路径仅为示例，请换成自己的位置：

```powershell
node scripts/setup.mjs init --harness-launcher "D:/Apps/Harness/resources/runtime/cli/bin/dsh.cmd"
node scripts/setup.mjs install
node scripts/setup.mjs install --apply
```

init只在新的.local/runtime中生成独立配置，不读取其他人的账本。默认跨项目/跨对话监测，任务文件由当前对话自动定位并逐任务登记，无工程任务自动保存交接摘要。--project只用于兼容原有明确根目录，可省略；不需要每个项目再安装或修改配置。可用--state选择新的运行目录。运行目录已有内容则拒绝覆盖。install默认预览，--apply只登记本项目MCP、四条钩子和一个Skill，不写信任记录或改变模型/安全设置。已有同名设置时保留并要求核对，不能盲目覆盖。

默认配置/队列在程序内.local/runtime；执行副本自动放到程序旁边的“程序目录名-Data/work”，避免交接本工具源码时包含自己的副本。自定义--state时副本放在该独立运行目录内。运行数据及旧数据目录都不会由卸载脚本递归清除。

## 2. 安装本地Harness插件

使用init输出的本机harness-plugin目录（不是源码模板目录）。先保存正在进行的工作，按Harness正常插件管理方式安装；若使用官方命令行安装desktop profile，应先按其要求完全退出Harness，再执行：

```powershell
& "D:/Apps/Harness/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add "D:/WorkHandoff/.local/runtime/harness-plugin"
```

路径按实际init输出替换。普通入口重开Harness，在插件页面确认Work Handoff运行正常。插件只通过官方服务管理新登记的任务聊天，不整理旧聊天。

## 3. 审核和加载原生钩子

首次安装在宿主钩子审核界面（当前CLI可用codex → /hooks）正常审核四条规则，再按宿主要求重载。安装脚本不代写审核结果。已审核且定义未变的钩子无需本程序重复提交审核。源码/配置写入不等于当前实例加载；原对话handoff_capabilities应确认与package.json一致的版本（本版0.3.0-beta.3）、scope=all-conversations及taskContext.configured=true，scheduler应为local-wall-clock-wake-preview。之后新增项目或对话不需要重新安装、审核或改目录名单。

需要手动安装时：init生成mcp.staged.toml和hooks.staged.json，可审阅后只合并这些项目设置；Skill源在skills/work-handoff-loop。不要替换整个用户配置。

## 4. 本地快检

```powershell
node scripts/doctor.mjs --config ".local/runtime/tools.local.json"
```

快检不查询账号、不调用模型、不创建任务/聊天/定时。插件未安装会返回needs-attention，属正常未就绪提示。检查标记存在不等于接口真正往返；原生钩子、实际额度、定时接回必须在宿主内实际核实。

同聊天使用当前Harness桌面的默认模型；本工具不会替用户切换。endpoint中的model只供保留的旧SDK路线使用，--model可明确指定；新管理任务不会回退旧SDK另建聊天。maxTokens、任务执行期限和测试计时均不默认注入。

## 5. 卸载

先结算或保留正在进行的任务并停止本任务调度，不强杀工人。预览再执行：

```powershell
node scripts/setup.mjs uninstall
node scripts/setup.mjs uninstall --apply
```

只移除此次安装且未被用户修改的MCP段、钩子和Skill文件；其他模型设置、工具、账号及所有任务数据都保留。项目段或Skill被编辑时会拒绝自动移除，须核对后人工处理。用Harness正常插件管理卸载本地插件。运行目录及备份是否清理由用户另行决定。

自定义运行目录需一直传相同--state。测试隔离安装可传--codex-home指定一个新目录；不要把测试安装指向日常配置。

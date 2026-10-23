# 使用与兼容规则

0.3.0-beta.2默认quotaHooks.scope=all-conversations，与resourceRoots解耦。taskContext.root保存无工程任务摘要。新工程按每个任务自动登记到工具账本，不写全局目录名单或要求重启。旧配置没有scope时仍保留原范围，需用明确迁移启用。

publish的input仍由GPT提供taskId、conversationId、title、objective、requirements、summary、remainingWork、acceptanceCriteria、version、requirementsVersion、recipients及可选deadlineAt。resourceRoot/workRoot/files可省略；这些字段由程序补齐。已有工程文件可传相对名称，附件可传已知绝对路径；只在当前工程内有限匹配文件名，不读取其他聊天、凭据或邻近文件。prepare_context是可选预览，不是额外用户审批步骤。needs-selection先由模型依本对话消歧，仍不明确时一次集中询问。任务上下文编号只防误绑，不是宿主身份认证；宿主原有审批和安全设置保持不变。

运行条件：Windows、Node.js 24+、支持原生MCP钩子/真实额度工具/原对话调度的本地GPT宿主，以及已正常登录的DeepSeek Harness桌面。CLI、桌面与模型版本不是同一版本，不互相推断。

工具次序：capabilities/status → 原生get_usage_limits、实际quota记录、next → publish → chat_prepare → chat_status → enqueue（side=harness，kind=execute/rework）→ dispatch（plan.outputs和deletions）→ managed_inspect → managed_collect → 独立验收 → review → prepare_commit → apply_commit → complete。work侧使用work_begin/work_finish，只改返回的副本。每次操作使用最新revision。

默认额度预留来自config的quotaPolicy：workPercent20、handoffPercent5、reviewPercent10、resumePercent40；继续需至少35，派发至少15，验收至少10，恢复至少40，两窗口均必须实际有效。它们是保守准入，不是任务消耗的精确预测，也不是本次90%触发测试参数。用户可在本机配置调整预留，调整后须覆盖自测。需要明确百分比触发时在当前已授权任务中明示规则，不能改用估算余额。

运行中应先保留稳定快照再实际验收。新的真实用户轮次使聊天序号变化，原通过结论不继续授权旧版写回。对于尚未应用的prepared提交可rollback释放准备，再managed_collect读取续聊成果；用户没提交的输入无法可靠检测，不能把空闲等同任务永久结束。已完成归档的任务不会自动复活。

本项目config/compatibility-policy.json固定低消耗规范：不因普通升级自动建测试聊天、模型任务或定时，不提高额度查询频率，不回滚整份用户配置。正常时安静。scripts/doctor.mjs是独立无模型快检入口，避免自查完全依赖可能失效的钩子；同一版本和能力组合可由宿主记住其signature，基本通过与真实任务验证分开记录。未知宿主版本不假称已经检测到。

快检不能证明原生钩子真的运行、额度实际恢复、未来定时真的接回或用户多轮完成。更新后首次真实任务完成时，结合当前capabilities、原生hook票据、真实接回、快照哈希和提交记录确认。接口异常先只暂停受影响操作；未知派发不重发，归档失败不重复提交。只有必要时按具体问题执行最小测试，不默认再跑大项目。

Skill不能自己读取账号后台或唤醒空闲模型。自动检查由已审核的宿主事件提示当前模型执行原生查询；定时接回依赖原生调度、电脑与桌面端可用。不存在不依赖宿主的常驻额度监控承诺。

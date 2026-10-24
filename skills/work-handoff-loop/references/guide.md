# 使用与兼容规则

beta.5替换beta.4默认询问通道：protocol=windows-desktop，独立Windows置顶窗口与当前选中对话无关，不依赖MCP表单审批。先正常加载新版；不能把旧MCP form立即返回视为用户拒绝。实际显示后计30秒，锁屏/安全桌面/断开会话不计时，55秒内无法可靠完成则不可用且不默许；无交互桌面或执行策略限制要明确报告。完全退出GPT及无运行任务时没有新的阈值触发事件，不宣称支持后台常驻监控或安全桌面显示。

0.3.0-beta.2默认quotaHooks.scope=all-conversations，与resourceRoots解耦。taskContext.root保存无工程任务摘要。新工程按每个任务自动登记到工具账本，不写全局目录名单或要求重启。旧配置没有scope时仍保留原范围，需用明确迁移启用。

publish的input仍由GPT提供taskId、conversationId、title、objective、requirements、summary、remainingWork、acceptanceCriteria、version、requirementsVersion、recipients及可选deadlineAt。resourceRoot/workRoot/files可省略；这些字段由程序补齐。已有工程文件可传相对名称，附件可传已知绝对路径；只在当前工程内有限匹配文件名，不读取其他聊天、凭据或邻近文件。prepare_context是可选预览，不是额外用户审批步骤。needs-selection先由模型依本对话消歧，仍不明确时一次集中询问。任务上下文编号只防误绑，不是宿主身份认证；宿主原有审批和安全设置保持不变。

运行条件：Windows、Node.js 24+、支持原生MCP钩子/真实额度工具/原对话调度的本地GPT宿主，以及已正常登录的DeepSeek Harness桌面。CLI、桌面与模型版本不是同一版本，不互相推断。

工具次序：capabilities/status → 原生get_usage_limits、实际quota记录、next → 达到阈值时handoff_confirm（allowed=true）→ publish → chat_prepare → chat_status → enqueue（side=harness，kind=execute/rework）→ dispatch（plan.outputs和deletions）→ managed_inspect → managed_collect → 独立验收 → review → prepare_commit → apply_commit → complete。work侧使用work_begin/work_finish，只改返回的副本。每次操作使用最新revision。

beta.4新增原生MCP form转交前询问，固定30秒未答默认转交；明确拒绝/取消、询问故障及原轮次中断不会默认放行。确认绑定任务及原对话并持久保存，并发或重启不重复弹窗、不会仅凭过期等待记录自动批准。拒绝在本次低额度阶段保持；用户明确要求再选时reconsider=true，实际恢复工作额度后重新触发阈值可再问。publish、资料准备、聊天创建及新派发在阈值状态下检查确认记录；MCP连接须支持form elicitation。文件更新后常驻工具需正常重载，capabilities.handoffConfirmation应显示enabled=true、timeoutMs=30000及supportedByCurrentClient=true。新增本地/标准MCP测试不等于真实桌面弹窗验收。

默认额度预留来自config的quotaPolicy：workPercent20、handoffPercent5、reviewPercent10、resumePercent40；继续需至少35，派发至少15，验收至少10，恢复至少40，两窗口均必须实际有效。它们是保守准入，不是任务消耗的精确预测，也不是本次90%触发测试参数。用户可在本机配置调整预留，调整后须覆盖自测。需要明确百分比触发时在当前已授权任务中明示规则，不能改用估算余额。

运行中应先保留稳定快照再实际验收。新的真实用户轮次使聊天序号变化，原通过结论不继续授权旧版写回。对于尚未应用的prepared提交可rollback释放准备，再managed_collect读取续聊成果；用户没提交的输入无法可靠检测，不能把空闲等同任务永久结束。已完成归档的任务不会自动复活。

本项目config/compatibility-policy.json固定低消耗规范：不因普通升级自动建测试聊天、模型任务或定时，不提高额度查询频率，不回滚整份用户配置。正常时安静。scripts/doctor.mjs是独立无模型快检入口，避免自查完全依赖可能失效的钩子；同一版本和能力组合可由宿主记住其signature，基本通过与真实任务验证分开记录。未知宿主版本不假称已经检测到。

快检不能证明原生钩子真的运行、额度实际恢复、未来定时真的接回或用户多轮完成。更新后首次真实任务完成时，结合当前capabilities、原生hook票据、真实接回、快照哈希和提交记录确认。接口异常先只暂停受影响操作；未知派发不重发，归档失败不重复提交。只有必要时按具体问题执行最小测试，不默认再跑大项目。

Skill不能自己读取账号后台或唤醒空闲模型。beta.3本地wake程序用官方控制连接独立查询额度并按现实到期时间尝试正常排队；仍依赖可连接的正确宿主与实际接回回执，未加载线程不能当空闲或保证唤醒。睡眠后补查，程序/两端停止运行不在当前保证内。详见docs/LOCAL-WAKE.md。

import { existsSync, readdirSync, unlinkSync, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HandoffError, record, requireCondition, text } from './contracts.js';
import { checkedRoot, digest, pathKey, resourcePath } from './packet.js';
import { atomicChatJson, CHAT_PROTOCOL, chatPolicy, initializeChatQueue, readChatJson, validateChatOperation } from './harness-chats.js';
export class HarnessChatManager {
    host;
    policy;
    constructor(host, policy) {
        this.host = host;
        this.policy = policy;
    }
    filename(binding) {
        return resourcePath(resourcePath(this.policy.queueRoot, 'bindings'), digest({ taskId: binding.taskId, conversationId: binding.conversationId }) + '.json', false);
    }
    async observation(binding) {
        let observed;
        try {
            observed = await this.host.sessionQuery.observeSession(binding.sessionId);
        }
        catch (error) {
            if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
                return null;
            throw error;
        }
        try {
            requireCondition(observed.header.id === binding.sessionId, 'CHAT_IDENTITY_MISMATCH', '宿主返回了其他会话。');
            const sequence = observed.projections?.asOfSeq ?? observed.events.at(-1)?.seq;
            requireCondition(Number.isSafeInteger(sequence) && Number(sequence) >= -1, 'CHAT_SEQUENCE_UNAVAILABLE', '无法核实聊天当前版本。');
            return { cwd: observed.header.cwd, sequence: Number(sequence), title: observed.projections?.values.title ?? null };
        }
        finally {
            observed[Symbol.dispose]();
        }
    }
    registered(binding) {
        const filename = this.filename(binding);
        requireCondition(existsSync(filename), 'CHAT_NOT_MANAGED', '聊天不属于本插件登记的新任务。');
        const stored = readChatJson(filename);
        requireCondition(stored.binding.sessionId === binding.sessionId && stored.binding.conversationId === binding.conversationId
            && stored.binding.taskId === binding.taskId && pathKey(stored.binding.workspaceRoot) === pathKey(binding.workspaceRoot), 'CHAT_IDENTITY_MISMATCH', '聊天登记归属不一致。');
        return stored;
    }
    async state(binding, stored) {
        const observed = await this.observation(binding), workspace = this.host.workspaceRegistry.get(stored.workspaceId);
        requireCondition(observed && observed.cwd && pathKey(checkedRoot(observed.cwd)) === pathKey(this.policy.workspaceRoot), 'CHAT_WORKSPACE_MISMATCH', '聊天起始工作区不符，保留现场。');
        requireCondition(workspace && pathKey(workspace.path) === pathKey(this.policy.workspaceRoot) && workspace.sessionIds.includes(binding.sessionId), 'CHAT_MEMBERSHIP_MISMATCH', '聊天不在登记的GPT交接工作区内。');
        const activity = await this.host.waterfall('workspace/session-activity', { sessionId: binding.sessionId }, () => Promise.resolve([]));
        return { sessionId: binding.sessionId, workspaceId: workspace.id, title: observed.title ?? stored.binding.title,
            sequence: observed.sequence, active: activity.length > 0, archived: this.host.workspaceRegistry.archivedSessionIds.includes(binding.sessionId) };
    }
    async call(value) {
        const operation = validateChatOperation(value), binding = operation.binding;
        requireCondition(binding.createdAt >= this.policy.enabledAt && pathKey(binding.workspaceRoot) === pathKey(this.policy.workspaceRoot), 'CHAT_LEGACY_EXCLUDED', '仅管理启用后登记到此工作区的新任务，不迁移旧聊天。');
        if (operation.kind === 'prepare') {
            const filename = this.filename(binding);
            let stored;
            if (!existsSync(filename)) {
                requireCondition(await this.observation(binding) === null, 'CHAT_ALREADY_EXISTS_UNMANAGED', '同名会话已存在且未登记，不接管或重命名。');
                const workspace = await this.host.workspaceRegistry.resolveByPath(this.policy.workspaceRoot)
                    ?? await this.host.workspaceRegistry.create(this.policy.workspaceRoot, 'GPT交接');
                stored = { binding, phase: 'creating', workspaceId: workspace.id, titleApplied: false };
                atomicChatJson(filename, stored); // Intent precedes creation. A lost reply is reconciled using this identity.
                const created = await this.host.sessionController.create({ sessionId: binding.sessionId, workspaceId: workspace.id });
                requireCondition(created.sessionId === binding.sessionId, 'CHAT_CREATE_ID_MISMATCH', '宿主返回了不同的新聊天编号，禁止重新创建。');
            }
            else {
                stored = this.registered(binding);
                requireCondition(stored.phase !== 'creating' || await this.observation(binding) !== null, 'CHAT_CREATE_UNKNOWN', '原创建结果未知，不能自动再次创建聊天。');
            }
            const workspace = this.host.workspaceRegistry.get(stored.workspaceId);
            requireCondition(workspace, 'CHAT_WORKSPACE_MISSING', '原工作区不存在，不自动另建替代会话。');
            if (!workspace.sessionIds.includes(binding.sessionId))
                await workspace.attachSession(binding.sessionId);
            if (!stored.titleApplied) {
                // If a user already named the newly created session, preserve that choice.
                if (!(await this.observation(binding))?.title)
                    await this.host.sessionController.rename({ sessionId: binding.sessionId, title: binding.title });
                stored.titleApplied = true;
            }
            stored.phase = this.host.workspaceRegistry.archivedSessionIds.includes(binding.sessionId) ? 'archived' : 'registered';
            atomicChatJson(filename, stored);
            return this.state(binding, stored);
        }
        const stored = this.registered(binding), current = await this.state(binding, stored);
        if (operation.kind === 'inspect')
            return current;
        if (current.archived)
            return current;
        requireCondition(!current.active, 'CHAT_STILL_ACTIVE', '聊天仍有工作，不能停止并归档。');
        requireCondition(current.sequence === operation.approval.sequence, 'CHAT_CHANGED_AFTER_REVIEW', '验收后聊天有更新，保留可见状态。');
        const latest = await this.observation(binding);
        requireCondition(latest?.sequence === operation.approval.sequence, 'CHAT_CHANGED_AFTER_REVIEW', '归档前聊天有更新。');
        await this.host.workspaceRegistry.archiveSession(binding.sessionId); // Never stopActivity:true.
        const archived = await this.state(binding, stored);
        requireCondition(archived.archived, 'CHAT_ARCHIVE_UNCONFIRMED', '归档结果未确认，仅记录整理待完成。');
        atomicChatJson(this.filename(binding), { ...stored, phase: 'archived', approval: operation.approval });
        return archived;
    }
}
export const name = 'work-handoff-chat-manager';
export const inject = ['workspaceRegistry', 'sessionController', 'sessionQuery'];
/** Official Cordis plugin entry, loaded into the existing desktop host. */
export async function apply(ctx, config) {
    let input = config;
    if (config && typeof config === 'object' && 'configFile' in config) {
        const row = record(config, ['configFile'], '聊天插件配置'), filename = text(row.configFile, '聊天配置文件', 4096);
        requireCondition(path.isAbsolute(filename), 'ABSOLUTE_PATH_REQUIRED', '聊天插件配置必须是绝对路径。');
        input = readChatJson(resourcePath(checkedRoot(path.dirname(filename)), path.basename(filename)));
    }
    const policy = chatPolicy(input);
    initializeChatQueue(policy);
    const manager = new HarnessChatManager(ctx, policy), requests = resourcePath(policy.queueRoot, 'requests'), responses = resourcePath(policy.queueRoot, 'responses');
    const instance = randomUUID(), readyFile = resourcePath(policy.queueRoot, 'ready.json', false);
    let disposed = false, chain = Promise.resolve(), watcher;
    const scan = async () => {
        if (disposed)
            return;
        for (const filename of readdirSync(requests).filter(name => /^[a-f0-9]{64}(?:-[a-f0-9-]{36})?\.json$/.test(name)).sort()) {
            if (disposed)
                break;
            const requestFile = resourcePath(requests, filename), responseFile = resourcePath(responses, filename, false);
            if (existsSync(responseFile))
                continue;
            const requestId = filename.slice(0, -5);
            let operation;
            try {
                const raw = readChatJson(requestFile);
                requireCondition(raw.protocol === CHAT_PROTOCOL && raw.requestId === requestId, 'CHAT_REQUEST_INVALID', '聊天请求身份不匹配。');
                operation = validateChatOperation(raw.operation);
                requireCondition(requestId.startsWith(digest(operation) + '-'), 'CHAT_REQUEST_INVALID', '聊天请求指纹不符。');
            }
            catch {
                ctx.logger.warn('Work Handoff: invalid chat-management request skipped; no chat changed.');
                continue;
            }
            let result;
            try {
                result = { state: await manager.call(operation) };
            }
            catch (error) {
                result = { errorCode: error instanceof HandoffError ? error.code : String(error.code ?? 'HARNESS_CHAT_HOST_ERROR') };
            }
            atomicChatJson(responseFile, { protocol: CHAT_PROTOCOL, requestId, operationSha256: digest(operation), ...result });
        }
    };
    const schedule = () => { chain = chain.then(scan).catch(() => { ctx.logger.warn('Work Handoff: invalid chat-management request retained for inspection; no model task sent.'); }); };
    const removeReady = () => {
        if (existsSync(readyFile) && readChatJson(readyFile).instance === instance)
            unlinkSync(readyFile);
    };
    ctx.effect(() => {
        watcher = watch(requests, schedule);
        watcher.on('error', () => { disposed = true; removeReady(); ctx.logger.warn('Work Handoff: chat-management watcher unavailable; existing work is retained.'); });
        atomicChatJson(readyFile, { protocol: CHAT_PROTOCOL, instance, workspaceRoot: policy.workspaceRoot, enabledAt: policy.enabledAt });
        schedule();
        return () => {
            disposed = true;
            watcher?.close();
            removeReady();
        };
    });
}
//# sourceMappingURL=harness-chat-plugin.js.map
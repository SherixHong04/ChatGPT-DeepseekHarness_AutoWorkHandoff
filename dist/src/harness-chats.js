import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HandoffError, canonical, id, positive, record, requireCondition, text } from './contracts.js';
import { checkedRoot, digest, pathKey, resourcePath } from './packet.js';
export const CHAT_PROTOCOL = 'work-handoff-chat-management-v1';
export function chatPolicy(value) {
    const row = record(value, ['queueRoot', 'workspaceRoot', 'enabledAt'], 'Harness聊天管理配置');
    const queueRoot = checkedRoot(row.queueRoot), workspaceRoot = checkedRoot(row.workspaceRoot);
    requireCondition(pathKey(queueRoot) !== pathKey(workspaceRoot), 'CHAT_PATH_COLLISION', '聊天请求与工作区目录须分开。');
    return { queueRoot, workspaceRoot, enabledAt: positive(row.enabledAt, '新聊天启用时间') };
}
export function newChatBinding(packet, policy) {
    requireCondition(packet.createdAt >= policy.enabledAt, 'CHAT_LEGACY_EXCLUDED', '仅管理启用后登记的新任务，不迁移旧聊天。');
    // The identifier is stable across retries and task-packet versions; the title is only presentation.
    const sessionId = 'wh-task-' + digest({ taskId: packet.taskId, conversationId: packet.conversationId }).slice(0, 32);
    const prefix = /^test[-_:]|测试|演练/.test(packet.taskId + ' ' + packet.title) ? '测试 · ' : 'GPT交接 · ';
    let title = prefix + packet.title.replace(/^(?:测试|GPT交接)\s*[·:：-]\s*/, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    while (Buffer.byteLength(title) > 76)
        title = [...title].slice(0, -1).join('');
    return { schemaVersion: 1, taskId: packet.taskId, conversationId: packet.conversationId, sessionId, title,
        workspaceRoot: policy.workspaceRoot, createdAt: packet.createdAt, phase: 'planned', workspaceId: null };
}
export function validateChatBinding(value) {
    const row = record(value, ['schemaVersion', 'taskId', 'conversationId', 'sessionId', 'title', 'workspaceRoot', 'createdAt', 'phase', 'workspaceId'], '新聊天归属');
    requireCondition(row.schemaVersion === 1 && ['planned', 'ready', 'archived'].includes(String(row.phase)), 'INVALID_CHAT_BINDING', '聊天归属版本或状态不正确。');
    const result = { schemaVersion: 1, taskId: id(row.taskId), conversationId: text(row.conversationId, '原会话', 256),
        sessionId: id(row.sessionId), title: text(row.title, '聊天标题', 128), workspaceRoot: checkedRoot(row.workspaceRoot),
        createdAt: positive(row.createdAt, '创建时间'), phase: row.phase,
        workspaceId: row.workspaceId === null ? null : text(row.workspaceId, '工作区编号', 256) };
    requireCondition(result.sessionId === 'wh-task-' + digest({ taskId: result.taskId, conversationId: result.conversationId }).slice(0, 32), 'CHAT_IDENTITY_MISMATCH', '聊天编号不属于所登记的新任务。');
    requireCondition(Buffer.byteLength(result.title) <= 76, 'CHAT_TITLE_TOO_LONG', '聊天标题超过安装版预留字节数。');
    return result;
}
export function validateChatOperation(value) {
    const row = record(value, ['kind', 'binding', 'approval'], '聊天管理操作'), binding = validateChatBinding(row.binding);
    requireCondition(['prepare', 'inspect', 'archive'].includes(String(row.kind)), 'CHAT_OPERATION_NOT_ALLOWED', '仅允许新聊天规划、状态查询及验收归档。');
    if (row.kind !== 'archive') {
        requireCondition(row.approval === undefined, 'INVALID_CHAT_APPROVAL', '此操作不接受归档凭据。');
        return { kind: row.kind, binding };
    }
    const proof = record(row.approval, ['resultId', 'snapshotId', 'sequence'], '验收版本');
    requireCondition(Number.isSafeInteger(proof.sequence) && Number(proof.sequence) >= 0, 'INVALID_CHAT_SEQUENCE', '验收须指明实际聊天版本。');
    return { kind: 'archive', binding, approval: { resultId: id(proof.resultId), snapshotId: id(proof.snapshotId), sequence: Number(proof.sequence) } };
}
export function validateChatState(value, binding) {
    const row = record(value, ['sessionId', 'workspaceId', 'title', 'sequence', 'active', 'archived'], 'Harness聊天状态');
    requireCondition(row.sessionId === binding.sessionId && typeof row.active === 'boolean' && typeof row.archived === 'boolean'
        && Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0, 'INVALID_CHAT_STATE', '聊天状态与登记身份或版本不符。');
    return { sessionId: binding.sessionId, workspaceId: text(row.workspaceId, '工作区编号', 256), title: text(row.title, '标题', 128),
        sequence: Number(row.sequence), active: row.active, archived: row.archived };
}
export function atomicChatJson(filename, value) {
    const directory = checkedRoot(path.dirname(filename));
    resourcePath(directory, path.basename(filename), false);
    const temporary = resourcePath(directory, '.write-' + randomUUID() + '.tmp', false);
    writeFileSync(temporary, canonical(value) + '\n', { flag: 'wx' });
    renameSync(temporary, filename);
}
export function readChatJson(filename) {
    const stat = lstatSync(filename);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 262_144, 'CHAT_REQUEST_INVALID', '聊天管理只读取有界的普通登记文件。');
    return JSON.parse(readFileSync(filename, 'utf8'));
}
/** Restricted local file transport to a plugin in the normal Harness host. No listener or credentials. */
export class FileChatPort {
    policy;
    acknowledgementMs;
    constructor(policy, acknowledgementMs = 10_000) {
        this.policy = policy;
        this.acknowledgementMs = acknowledgementMs;
    }
    async call(input) {
        const operation = validateChatOperation(input);
        requireCondition(pathKey(operation.binding.workspaceRoot) === pathKey(this.policy.workspaceRoot), 'CHAT_WORKSPACE_MISMATCH', '只能管理配置中的交接工作区。');
        const heartbeat = resourcePath(this.policy.queueRoot, 'ready.json', false);
        requireCondition(existsSync(heartbeat), 'HARNESS_CHAT_PLUGIN_UNAVAILABLE', 'Harness聊天管理插件尚未加载；保留现场，不创建未分组聊天。');
        const ready = readChatJson(heartbeat);
        requireCondition(ready.protocol === CHAT_PROTOCOL && ready.workspaceRoot === this.policy.workspaceRoot && ready.enabledAt === this.policy.enabledAt, 'HARNESS_CHAT_PLUGIN_MISMATCH', '插件与任务工具的工作区或启用时间不一致。');
        const key = digest(operation), requests = resourcePath(this.policy.queueRoot, 'requests'), responses = resourcePath(this.policy.queueRoot, 'responses');
        // The operation digest and registered session are stable. Each explicit call gets a fresh receipt,
        // allowing reconciliation of a previous refusal; the host never creates a second session or resends a model task.
        const requestId = key + '-' + randomUUID();
        const request = resourcePath(requests, requestId + '.json', false), response = resourcePath(responses, requestId + '.json', false);
        if (!existsSync(request)) {
            try {
                writeFileSync(request, canonical({ protocol: CHAT_PROTOCOL, requestId, operation }) + '\n', { flag: 'wx' });
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
        }
        const until = Date.now() + this.acknowledgementMs;
        while (!existsSync(response) && Date.now() < until)
            await new Promise(resolve => setTimeout(resolve, 80));
        requireCondition(existsSync(response), 'HARNESS_CHAT_REPLY_PENDING', '管理请求已登记但未收到明确回执，只按原请求对账，不另建聊天。');
        const reply = readChatJson(response);
        requireCondition(reply.protocol === CHAT_PROTOCOL && reply.requestId === requestId && reply.operationSha256 === digest(operation), 'CHAT_REPLY_MISMATCH', '聊天管理回执不属于本次登记操作。');
        if (reply.errorCode)
            throw new HandoffError(text(reply.errorCode, '错误码', 128), 'Harness聊天管理未完成，保留任务及聊天原状。');
        return validateChatState(reply.state, operation.binding);
    }
}
export function initializeChatQueue(policy) {
    for (const name of ['requests', 'responses', 'bindings']) {
        const directory = resourcePath(policy.queueRoot, name, false);
        mkdirSync(directory, { recursive: true });
        checkedRoot(directory);
    }
}
//# sourceMappingURL=harness-chats.js.map
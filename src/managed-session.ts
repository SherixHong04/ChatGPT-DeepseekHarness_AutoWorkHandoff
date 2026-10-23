import { existsSync, mkdirSync, readdirSync, watch, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HandoffError, canonical, id, record, requireCondition, text } from './contracts.js';
import { digest, pathKey, resourcePath, checkedRoot, resources, verifyResources } from './packet.js';
import { atomicChatJson, readChatJson, validateChatBinding } from './harness-chats.js';
import type { ChatBinding, ChatPolicy, ChatState } from './harness-chats.js';
import { HarnessChatManager } from './harness-chat-plugin.js';
import type { HarnessChatHost } from './harness-chat-plugin.js';
import type { Resource } from './contracts.js';

export interface RunRequest { kind: 'start' | 'inspect'; binding: ChatBinding; commandId: string; directory: string; prompt: string; inputs: Resource[] }
export interface RunState { chat: ChatState; phase: 'intent' | 'accepted' | 'unknown'; acceptedAt: number | null;
  sequence: number; turnReason: string | null; messages: { seq: number; role: 'user' | 'assistant'; text: string }[] }
interface RunRecord { signature: string; phase: RunState['phase']; acceptedAt: number | null; beforeSequence: number }
export interface RunHost extends HarnessChatHost {
  sessionController: HarnessChatHost['sessionController'] & {
    prompt(request: { sessionId: string; requestId: string; mode: 'followup'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<{ accepted: boolean }>;
  };
}
const PROTOCOL = 'work-handoff-managed-session-v1';
function request(value: unknown, policy: ChatPolicy): RunRequest {
  const row = record(value, ['kind', 'binding', 'commandId', 'directory', 'prompt', 'inputs'], '同聊天执行请求');
  requireCondition(row.kind === 'start' || row.kind === 'inspect', 'INVALID_RUN_OPERATION', '只允许启动已登记指令或查询。');
  const binding = validateChatBinding(row.binding), commandId = id(row.commandId);
  requireCondition(pathKey(binding.workspaceRoot) === pathKey(policy.workspaceRoot), 'CHAT_WORKSPACE_MISMATCH', '执行只在已登记工作区中。');
  const directory = checkedRoot(row.directory);
  requireCondition(pathKey(directory) === pathKey(resourcePath(policy.workspaceRoot, commandId)), 'RUN_DIRECTORY_MISMATCH', '副本须位于工作区内本指令的专用目录。');
  return { kind: row.kind, binding, commandId, directory, prompt: text(row.prompt, '交接指令', 120_000), inputs: resources(row.inputs) };
}
export class ManagedSession {
  private readonly chats: HarnessChatManager;
  constructor(private readonly host: RunHost, private readonly policy: ChatPolicy) { this.chats = new HarnessChatManager(host, policy); }
  async call(value: unknown): Promise<RunState> {
    const input = request(value, this.policy), chat = await this.chats.call({ kind: 'inspect', binding: input.binding });
    requireCondition(!chat.archived, 'CHAT_ARCHIVED', '已归档聊天不能自动恢复执行。');
    const filename = resourcePath(this.policy.queueRoot, 'runs/' + input.commandId + '.json', false);
    const signature = digest({ ...input, kind: 'start' });
    let run: RunRecord | null = existsSync(filename) ? readChatJson(filename) as RunRecord : null;
    if (run) requireCondition(run.signature === signature, 'RUN_PLAN_CONFLICT', '重复请求不能替换指令或副本。');
    if (!run) {
      requireCondition(input.kind === 'start', 'RUN_NOT_STARTED', '尚无本指令执行登记。');
      requireCondition(!chat.active, 'CHAT_STILL_ACTIVE', '用户仍在此聊天工作，不能插入新模型任务。');
      verifyResources(input.directory, input.inputs); // Host itself must see the exact transferred bytes.
      run = { signature, phase: 'intent', acceptedAt: null, beforeSequence: chat.sequence };
      // Exclusive durable intent also prevents two host instances from sending
      // the same prompt. A partial/crashed record requires reconciliation.
      writeFileSync(filename, canonical(run) + '\n', { flag: 'wx' });
      try {
        const result = await this.host.sessionController.prompt({ sessionId: input.binding.sessionId,
          requestId: input.commandId, mode: 'followup', content: [{ type: 'text', text: input.prompt }] }, new AbortController().signal);
        requireCondition(result.accepted, 'RUN_NOT_ACCEPTED', '宿主未确认接收。');
        run.phase = 'accepted'; run.acceptedAt = Date.now(); atomicChatJson(filename, run);
      } catch (error) { run.phase = 'unknown'; atomicChatJson(filename, run); throw error; }
    }
    const observed = await this.host.sessionQuery.observeSession(input.binding.sessionId);
    const observedSequence = observed.projections?.asOfSeq ?? observed.events.at(-1)?.seq ?? -1;
    const messages: RunState['messages'] = []; let turnReason: string | null = null;
    try {
      // Only this registered task's user and assistant text. Reasoning, system
      // prompts, credentials and tool output bodies are deliberately excluded.
      for (const raw of observed.events) {
        const event = raw as { seq: number; type?: string; data?: any };
        if (event.seq <= run.beforeSequence) continue;
        if (event.type === 'turn/start') turnReason = null;
        if (event.type === 'turn/end') turnReason = event.data?.reason?.kind ?? null;
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
        if (event.type === 'user/message' && event.data?.source?.kind !== 'user') continue;
        const content = event.type === 'assistant/message' ? event.data?.message?.content : event.data?.content;
        if (!Array.isArray(content)) continue;
        const body = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
        if (!body) continue;
        requireCondition(Buffer.byteLength(body) <= 120_000 && messages.length < 256, 'RUN_HISTORY_TOO_LARGE', '任务聊天需分段验收，不能截断后视为完整。');
        messages.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text: body });
      }
    } finally { observed[Symbol.dispose](); }
    const latest = await this.chats.call({ kind: 'inspect', binding: input.binding });
    requireCondition(latest.sequence === observedSequence, 'RUN_CHANGED_DURING_READ', '读取期间聊天变化，须重新读取，不能验收旧版本。');
    return { chat: latest, phase: run.phase, acceptedAt: run.acceptedAt, sequence: latest.sequence, turnReason, messages };
  }
}
export async function runPort(policy: ChatPolicy, input: RunRequest): Promise<RunState> {
  request(input, policy);
  const ready = readChatJson(resourcePath(policy.queueRoot, 'run-ready.json')) as { protocol?: string; workspaceRoot?: string };
  requireCondition(ready.protocol === PROTOCOL && ready.workspaceRoot === policy.workspaceRoot, 'MANAGED_EXECUTOR_NOT_READY', '同聊天执行插件尚未加载。');
  const requestId = randomUUID(), requestFile = resourcePath(policy.queueRoot, 'run-requests/' + requestId + '.json', false);
  const responseFile = resourcePath(policy.queueRoot, 'run-responses/' + requestId + '.json', false);
  atomicChatJson(requestFile, { requestId, input });
  const until = Date.now() + 15_000;
  while (!existsSync(responseFile) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 80));
  requireCondition(existsSync(responseFile), 'RUN_REPLY_UNKNOWN', '已登记请求但回执未知，只对账，不能重新发送。');
  const reply = readChatJson(responseFile) as { requestId: string; signature: string; state?: RunState; errorCode?: string };
  requireCondition(reply.requestId === requestId && reply.signature === digest(input), 'RUN_REPLY_MISMATCH', '执行回执不匹配。');
  if (reply.errorCode) throw new HandoffError(reply.errorCode, '同聊天执行未完成，请保留现场。');
  requireCondition(reply.state?.chat.sessionId === input.binding.sessionId, 'RUN_REPLY_MISMATCH', '执行聊天不匹配。');
  return reply.state;
}
export function installManagedSession(host: RunHost & { effect(action: () => () => void): unknown }, policy: ChatPolicy): void {
  for (const name of ['runs', 'run-requests', 'run-responses']) mkdirSync(resourcePath(policy.queueRoot, name, false), { recursive: true });
  const manager = new ManagedSession(host, policy); let chain = Promise.resolve();
  const scan = async () => {
    for (const name of readdirSync(resourcePath(policy.queueRoot, 'run-requests')).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      const response = resourcePath(policy.queueRoot, 'run-responses/' + name, false); if (existsSync(response)) continue;
      const raw = readChatJson(resourcePath(policy.queueRoot, 'run-requests/' + name)) as { requestId: string; input: unknown };
      requireCondition(raw.requestId + '.json' === name, 'RUN_REQUEST_MISMATCH', '请求编号不匹配。');
      let result;
      try { result = { state: await manager.call(raw.input) }; }
      catch (error) { result = { errorCode: error instanceof HandoffError ? error.code : 'RUN_HOST_ERROR' }; }
      atomicChatJson(response, { requestId: raw.requestId, signature: digest(raw.input), ...result });
    }
  };
  host.effect(() => {
    const instance = randomUUID(), ready = resourcePath(policy.queueRoot, 'run-ready.json', false);
    const removeReady = () => { if (existsSync(ready) && (readChatJson(ready) as { instance?: string }).instance === instance) unlinkSync(ready); };
    const schedule = () => { chain = chain.then(scan).catch(() => {
      atomicChatJson(resourcePath(policy.queueRoot, 'run-error.json', false), { code: 'RUN_QUEUE_ERROR', at: Date.now() });
    }); };
    const watcher = watch(resourcePath(policy.queueRoot, 'run-requests'), schedule);
    watcher.on('error', () => { watcher.close(); removeReady(); });
    atomicChatJson(ready, { protocol: PROTOCOL, workspaceRoot: policy.workspaceRoot, pid: process.pid, instance });
    schedule(); return () => { watcher.close(); removeReady(); };
  });
}

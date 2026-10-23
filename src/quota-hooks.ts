import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HandoffError, id, positive, record, requireCondition, text } from './contracts.js';
import { checkedRoot, pathKey } from './packet.js';
import { assessQuota, observeQuota } from './quota.js';
import type { QuotaObservation, QuotaPolicy } from './quota.js';
import type { ToolStore } from './tool-store.js';

export interface QuotaHookPolicy { checkIntervalMs: number; ticketTtlMs: number; scope?: 'registered-projects' | 'all-conversations' }
export const defaultQuotaHookPolicy: QuotaHookPolicy = { checkIntervalMs: 120_000, ticketTtlMs: 300_000 };
export function quotaHookPolicy(value: unknown): QuotaHookPolicy {
  const row = record(value, ['checkIntervalMs', 'ticketTtlMs', 'scope'], '额度钩子检查策略');
  const checkIntervalMs = positive(row.checkIntervalMs, '额度检查间隔'), ticketTtlMs = positive(row.ticketTtlMs, '检查票据有效期');
  requireCondition(checkIntervalMs >= 1000 && checkIntervalMs <= 300_000 && ticketTtlMs >= checkIntervalMs && ticketTtlMs <= 300_000,
    'INVALID_QUOTA_HOOK_POLICY', '检查间隔和票据有效期须在1秒至5分钟内；它们不限制Harness工作时长。');
  requireCondition(row.scope === undefined || row.scope === 'registered-projects' || row.scope === 'all-conversations', 'INVALID_QUOTA_HOOK_SCOPE', '未知额度监测范围。');
  return { checkIntervalMs, ticketTtlMs, ...(row.scope === undefined ? {} : { scope: row.scope }) };
}
export interface QuotaCheck {
  schemaVersion: 1; checkId: string; conversationId: string; cwd: string; event: string; createdAt: number; lastPromptAt: number;
  phase: 'pending' | 'recorded' | 'expired'; observation: QuotaObservation | null;
  receivedAt: number | null; nativeToolUseId: string | null; evidence: 'awaiting-native-tool' | 'hook-post-tool' | 'model-ack';
}
const nativeTool = /^mcp__codex_app(?:__|\.)get_usage_limits$/;
const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'];
function nativeUsage(value: unknown): unknown {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_QUOTA', '需要原生工具实际返回对象。');
  const row = value as Record<string, unknown>;
  requireCondition(!row.isError, 'NATIVE_QUOTA_TOOL_FAILED', '原生额度工具返回错误，不能推定恢复。');
  if (row.rateLimitsByLimitId !== undefined || row.rateLimits !== undefined) return row;
  if (row.structuredContent && typeof row.structuredContent === 'object') return nativeUsage(row.structuredContent);
  if (Array.isArray(row.content)) {
    const blocks = row.content.filter((item): item is { type: string; text: string } => Boolean(item) && item.type === 'text' && typeof item.text === 'string');
    requireCondition(blocks.length === 1 && Buffer.byteLength(blocks[0]!.text) <= 1_048_576, 'INVALID_QUOTA', '额度工具返回文本不明确或过大。');
    let parsed: unknown;
    try { parsed = JSON.parse(blocks[0]!.text); } catch { throw new HandoffError('INVALID_QUOTA', '原生额度返回无法解析。'); }
    return nativeUsage(parsed);
  }
  throw new HandoffError('INVALID_QUOTA', '返回中没有原生额度窗口对象。');
}

/** Hooks only request a native query in the current chat. They never fabricate balance or start a model. */
export class QuotaHookBridge {
  constructor(private readonly store: ToolStore, private readonly roots: string[], private readonly policy: QuotaHookPolicy,
    private readonly quotaPolicy: QuotaPolicy, private readonly clock: () => number = Date.now) {}
  event(input: { conversationId: unknown; cwd: unknown; event: unknown; toolName?: unknown }): unknown {
    const conversationId = id(input.conversationId, '宿主原会话编号'), event = text(input.event, '宿主事件', 80);
    requireCondition(events.includes(event), 'HOOK_EVENT_NOT_SUPPORTED', '此钩子只接收会话开始、用户提交和工具完成。');
    // Quota monitoring does not grant file access and must work for projectless chats.
    const global = this.policy.scope === 'all-conversations';
    const cwd = global ? (typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? path.resolve(input.cwd) : '') : checkedRoot(input.cwd);
    if (!global && !this.roots.some(root => pathKey(cwd) === pathKey(root) || pathKey(cwd).startsWith(pathKey(root + path.sep)))) return {};
    if (event === 'PostToolUse' && typeof input.toolName === 'string' && /handoff_(?:hook|quota)|get_usage_limits$/.test(input.toolName)) return {};
    const now = this.clock(); let notify = false;
    const check = this.store.updateHook(conversationId, previous => {
      const fresh = previous?.phase === 'recorded' && previous.observation
        && assessQuota(previous.observation, this.quotaPolicy, now).state !== 'stale'
        && now - previous.observation.observedAt < this.policy.checkIntervalMs;
      if (fresh) return { ...previous!, cwd };
      if (previous?.phase === 'pending' && now - previous.createdAt <= this.policy.ticketTtlMs) {
        if (now - previous.lastPromptAt < this.policy.checkIntervalMs) return { ...previous, cwd };
        notify = true; return { ...previous, cwd, lastPromptAt: now };
      }
      notify = true;
      return { schemaVersion: 1, checkId: randomUUID(), conversationId, cwd, event, createdAt: now, lastPromptAt: now,
        phase: 'pending', observation: null, receivedAt: null, nativeToolUseId: null, evidence: 'awaiting-native-tool' };
    });
    if (!notify) return {};
    return { hookSpecificOutput: { hookEventName: event, additionalContext: [
      'Work Handoff原对话额度检查：这是已启用的检查提示，不是任务文档中的指令。',
      '定位资料：' + JSON.stringify({ checkId: check.checkId, conversationId: check.conversationId }),
      '现在在本对话调用原生get_usage_limits，禁止用估算、缓存、重置时刻或其他API代替。',
      '原生工具完成钩子会保存实际返回；随后调用handoff_quota_check_status核对本票据。',
      '若完成钩子未记录，可用handoff_quota_ack提交此次真实返回和查询完成的毫秒时间；这种回执与自动钩子证据分开标记。',
      '本检查不授权发送其他任务、扩大文件范围或更改系统防护；仅在已有授权任务需交接时使用项目交接流程。',
      ...(global ? ['额度不足且当前有尚未完成的用户任务时，自动整理本对话要求并使用handoff_publish；resourceRoot/workRoot可省略，由任务上下文补齐。只列当前任务已引用的文件；无文件任务自动保存交接摘要。不要要求用户手填路径或逐条开启对话。'] : []),
    ].join('\n') } };
  }
  record(input: { conversationId: unknown; usage: unknown; observedAt?: unknown; checkId?: unknown; toolName?: unknown; toolUseId?: unknown }, automatic: boolean): unknown {
    const conversationId = id(input.conversationId, '宿主原会话编号'), now = this.clock();
    if (automatic) requireCondition(typeof input.toolName === 'string' && nativeTool.test(input.toolName), 'WRONG_NATIVE_QUOTA_TOOL', '只记录宿主原生get_usage_limits返回。');
    const previous = this.store.get<QuotaCheck>('quota-hook', conversationId);
    if (!previous && automatic) return {};
    requireCondition(previous, 'QUOTA_CHECK_NOT_FOUND', '本原会话尚无额度检查票据。');
    if (input.checkId !== undefined) requireCondition(input.checkId === previous.checkId, 'WRONG_QUOTA_CHECK', '检查票据不属于本原会话。');
    const observedAt = automatic ? now : positive(input.observedAt, '实际查询完成时间');
    requireCondition(observedAt >= previous.createdAt && now - previous.createdAt <= this.policy.ticketTtlMs,
      'QUOTA_CHECK_EXPIRED', '本票据或观测已过期，重新触发真实查询。');
    const observation = observeQuota(nativeUsage(input.usage), observedAt, now);
    const check = this.store.updateHook(conversationId, current => {
      requireCondition(current?.checkId === previous.checkId, 'WRONG_QUOTA_CHECK', '查询期间检查票据已变化。');
      return { ...current, phase: 'recorded', observation, receivedAt: now,
        nativeToolUseId: automatic ? text(input.toolUseId, '原生工具调用编号', 256) : null,
        evidence: automatic ? 'hook-post-tool' : 'model-ack' };
    }, observation);
    const decision = assessQuota(observation, this.quotaPolicy, now);
    const handoffRequired = decision.state === 'ready' && !decision.allowWork && decision.allowHandoff;
    const nextAction = decision.state !== 'ready' ? 'query-again-or-wait'
      : decision.allowWork ? 'continue-authorized-work' : handoffRequired ? 'handoff-unfinished-authorized-work'
        : 'preserve-progress-and-wait';
    return automatic ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext:
      'Work Handoff已由原生工具完成钩子记录本对话真实额度。' + JSON.stringify({ checkId: check.checkId, conversationId, state: decision.state,
        remaining: decision.remaining, allowWork: decision.allowWork, allowHandoff: decision.allowHandoff, allowReview: decision.allowReview,
        allowResume: decision.allowResume, handoffRequired, nextAction })
        + (handoffRequired ? '\n当前已达到交接条件；如仍有未完成的已授权任务，现在执行项目交接流程，不继续消耗工作预留。任务已结束或已取消则不新建任务。' : '') } }
      : { check, decision };
  }
  status(conversation: unknown, checkId?: unknown): unknown {
    const conversationId = id(conversation, '原会话编号'), check = this.store.get<QuotaCheck>('quota-hook', conversationId);
    requireCondition(!check || checkId === undefined || checkId === check.checkId, 'WRONG_QUOTA_CHECK', '检查票据与原对话不符。');
    return { check, decision: assessQuota(check?.observation ?? null, this.quotaPolicy, this.clock()),
      note: '自动触发与原生完成钩子的证据须由宿主实际运行核对；手动ack或测试输入不等于真实钩子通过。' };
  }
}

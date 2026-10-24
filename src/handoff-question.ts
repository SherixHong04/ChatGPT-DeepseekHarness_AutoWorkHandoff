import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { HandoffPrompt } from './handoff-consent.js';
import { HANDOFF_QUESTION_MS } from './handoff-consent.js';

/** Standard MCP elicitation, associated with the originating tool call and cancellable turn. */
export function mcpHandoffPrompt(server: Server, relatedRequestId: RequestId): HandoffPrompt {
  return async (offer, signal) => {
    if (!server.getClientCapabilities()?.elicitation?.form || signal?.aborted) return 'unavailable';
    const start = Date.now();
    try {
      const reply = await server.elicitInput({ mode: 'form',
        message: `额度已达到转交阈值。是否开始打包并转交任务“${offer.title}”到 Harness？30 秒内未回答将自动开始；选择暂不转交或取消会停止本次自动转交。`,
        requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: '转交选择',
          enum: ['立即转交', '暂不转交'] } }, required: ['decision'] } },
      { relatedRequestId, ...(signal ? { signal } : {}), timeout: HANDOFF_QUESTION_MS, maxTotalTimeout: HANDOFF_QUESTION_MS, resetTimeoutOnProgress: false });
      if (reply.action !== 'accept') return 'decline';
      return reply.content?.decision === '立即转交' ? 'handoff' : 'decline';
    } catch (error) {
      if (signal?.aborted) return 'cancelled';
      return error instanceof McpError && error.code === ErrorCode.RequestTimeout && Date.now() - start >= HANDOFF_QUESTION_MS
        ? 'timeout' : 'unavailable';
    }
  };
}

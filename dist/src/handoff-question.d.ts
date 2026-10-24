import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { HandoffPrompt } from './handoff-consent.js';
/** Standard MCP elicitation, associated with the originating tool call and cancellable turn. */
export declare function mcpHandoffPrompt(server: Server, relatedRequestId: RequestId): HandoffPrompt;

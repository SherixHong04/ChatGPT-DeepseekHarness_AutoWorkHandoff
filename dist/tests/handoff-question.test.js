import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpHandoffPrompt } from '../src/handoff-question.js';
test('standard MCP form preserves user choices and really times out after 30 seconds without a model', async (t) => {
    const server = new Server({ name: 'isolated-consent-server', version: '1' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'isolated-consent-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    let choice = 'accept', questions = 0;
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        questions++;
        assert.match(request.params.message, /30 秒/);
        if (choice === 'silent')
            return new Promise(resolve => extra.signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true }));
        return choice === 'accept' ? { action: 'accept', content: { decision: '立即转交' } } : { action: choice };
    });
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
        const now = Date.now(), offer = { taskId: 'isolated-task', conversationId: 'isolated-chat', requestId: 'isolated-request', title: 'isolated fixture',
            recoveryAt: 0, createdAt: now, deadlineAt: now + 30_000, settledAt: null, phase: 'waiting', reason: 'question-pending' };
        const answer = await mcpHandoffPrompt(server, extra.requestId)(offer, extra.signal);
        return { content: [{ type: 'text', text: answer }] };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    t.after(async () => { await client.close(); await server.close(); });
    const call = async () => { const r = await client.callTool({ name: 'isolated-probe', arguments: {} }); return r.content[0]?.text; };
    assert.equal(await call(), 'handoff');
    choice = 'decline';
    assert.equal(await call(), 'decline');
    choice = 'cancel';
    assert.equal(await call(), 'decline');
    choice = 'silent';
    const started = performance.now();
    assert.equal(await call(), 'timeout');
    assert(performance.now() - started >= 30_000);
    assert.equal(questions, 4);
});
//# sourceMappingURL=handoff-question.test.js.map
// Project-authored protocol peer for tests. It never contacts a model or a network endpoint.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const mode = process.argv[2] ?? 'success';
const input = createInterface({ input: process.stdin });
let cwd = process.cwd(), sessionId = '', seq = 0, messageId = '', done = false;
let waiter: number | undefined;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id: number, value: unknown) => send({ jsonrpc: '2.0', id, result: value });
const event = (type: string, data: unknown) => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, seq: seq++, data } } });
function complete(): void {
  event('agent/inbox/spliced', { inserted: [{ id: messageId }] }); event('step/start', { turn: 1, step: 1 });
  event('user/message', { id: messageId, content: [{ type: 'text', text: 'fixture' }] });
  if (mode === 'hold') { writeFileSync(path.join(cwd, 'input.txt'), 'paused progress\n'); return; }
  if (mode === 'crash') { setTimeout(() => process.exit(23), 120); return; }
  if (mode === 'resume-seed') {
    const before = readFileSync(path.join(cwd, 'input.txt'), 'utf8');
    writeFileSync(path.join(cwd, 'input.txt'), before === 'paused progress\n' ? 'resumed saved progress\n' : 'WRONG_SEED\n');
  } else if (mode === 'verify-seed') {
    const before = readFileSync(path.join(cwd, 'input.txt'), 'utf8');
    writeFileSync(path.join(cwd, 'input.txt'), before === 'edited by local fixture\n' ? 'refined previous result\n' : 'WRONG_SEED\n');
  } else if (mode !== 'missing') writeFileSync(path.join(cwd, 'input.txt'), 'edited by local fixture\n');
  const manifest = { summary: 'Fixture edited', acceptanceNotes: ['local peer'], files: [mode === 'missing' ? 'missing.txt' : mode === 'undeclared' ? 'secret.txt' : 'input.txt'], deletions: [] };
  event('assistant/message', { message: { content: [{ type: 'text', text: mode === 'bad-json' ? 'Not a result manifest' : JSON.stringify(manifest) }] } });
  event('turn/end', { turn: 1, reason: { kind: mode === 'max-tokens' ? 'max-tokens' : mode === 'blocked' ? 'blocked' : 'completed' } });
  send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } }); done = true;
  if (waiter !== undefined) result(waiter, {});
}
input.on('line', line => {
  const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
  switch (request.method) {
    case 'initialize':
      cwd = String(request.params?.cwd);
      if (mode === 'no-token-override' && Object.hasOwn(request.params ?? {}, 'maxTokens')) {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'maxTokens must be omitted' } }); break;
      }
      if (mode === 'startup-log') process.stdout.write('[llm-deepseek-account] fixture catalog diagnostic\n');
      if (mode === 'stdout-noise') process.stdout.write('unexpected untrusted stdout\n');
      result(request.id, { serverInfo: { name: mode === 'wrong-identity' ? 'other-runtime' : 'deepseek-harness-sdk-runtime', version: 'fixture' } }); break;
    case 'session/working-directory/get': result(request.id, { cwd: mode === 'wrong-cwd' ? path.dirname(cwd) : cwd }); break;
    case 'session/prompt':
      sessionId = String(request.params?.sessionId); messageId = `fixture-message-${request.id}`;
      appendFileSync(path.join(cwd, '.fixture-prompt-count'), '1\n');
      if (mode === 'early-events') complete();
      result(request.id, { messageId });
      if (mode !== 'early-events') setTimeout(complete, 50); break;
    case 'session/wait':
      if (mode === 'missing-wait') send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method unavailable' } });
      else if (done || !messageId) result(request.id, {}); else waiter = request.id; break;
    case 'shutdown':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n', () => process.exit(0)); break;
    case 'fixture/pending': break; // Owned fixture: deliberately awaits shutdown instead of replying.
    default: send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported fixture method' } });
  }
});
input.on('close', () => process.exit(0));

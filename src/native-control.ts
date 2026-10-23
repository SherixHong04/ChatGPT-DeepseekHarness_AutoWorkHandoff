import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import WebSocket from 'ws';

/** Use the installed official proxy; never start, resume or replace an app-server. */
export function codexLauncher(): { command: string; args: string[] } {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(exe) && fs.statSync(exe).isFile()) return { command: exe, args: [] };
    const script = path.join(dir, 'node_modules/@openai/codex/bin/codex.js');
    if (fs.existsSync(script)) return { command: process.execPath, args: [script] };
  }
  throw new Error('CODEX_CLI_NOT_FOUND');
}
export class NativeRpcError extends Error {
  constructor(readonly code: number) { super('NATIVE_RPC_REJECTED'); }
}
export interface ControlPort { request(method: string, params?: unknown): Promise<any>; close(): void }

export class NativeControl implements ControlPort {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private constructor(private readonly socket: WebSocket, private readonly child: ReturnType<typeof spawn>) {
    socket.on('message', data => {
      let row: any; try { row = JSON.parse(data.toString()); } catch { this.fail(); return; }
      if (row.id !== undefined && row.method) {
        socket.send(JSON.stringify({ id: row.id, error: { code: -32601, message: 'This client does not resolve model approvals or tools.' } })); return;
      }
      const item = this.pending.get(row.id); if (!item) return;
      clearTimeout(item.timer); this.pending.delete(row.id);
      row.error ? item.reject(new NativeRpcError(Number(row.error.code))) : item.resolve(row.result);
    });
    socket.on('close', () => this.fail()); socket.on('error', () => this.fail()); child.on('error', () => this.fail());
  }
  static async connect(): Promise<NativeControl> {
    const launcher = codexLauncher();
    const child = spawn(launcher.command, [...launcher.args, 'app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr?.resume();
    // proxy forwards raw WebSocket bytes, not JSONL. No network listener or credentials are created.
    const socket = new WebSocket('ws://localhost/', { perMessageDeflate: false, maxPayload: 4_194_304, handshakeTimeout: 10_000,
      createConnection: () => Duplex.from({ readable: child.stdout!, writable: child.stdin! }) as Socket });
    child.once('error', () => socket.terminate());
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new Error('NATIVE_CONNECTION_UNAVAILABLE'))); });
      const client = new NativeControl(socket, child);
      await client.request('initialize', { clientInfo: { name: 'work_handoff_local_wake', version: '0.3.0-beta.3' }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: 'initialized' })); return client;
    } catch { socket.terminate(); child.kill(); throw new Error('NATIVE_CONNECTION_UNAVAILABLE'); }
  }
  request(method: string, params?: unknown): Promise<any> {
    if (!['initialize', 'account/rateLimits/read', 'thread/read', 'thread/turns/list', 'thread/queue/add', 'thread/queue/list'].includes(method))
      return Promise.reject(new Error('METHOD_NOT_ALLOWED'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('NATIVE_REQUEST_TIMEOUT')); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('NATIVE_SEND_UNCERTAIN')); }
      });
    });
  }
  private fail(): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('NATIVE_CONNECTION_CLOSED')); } this.pending.clear(); }
  close(): void { this.fail(); this.socket.terminate(); this.child.stdin?.end(); this.child.kill(); }
}

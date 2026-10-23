import path from 'node:path';
import { lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { HandoffError, positive, record, requireCondition, text } from './contracts.js';
import { checkedRoot, resourcePath } from './packet.js';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateEndpoint(value) {
    const row = record(value, ['launcher', 'profile', 'provider', 'model', 'reasoningEffort', 'maxTokens'], 'Harness执行端配置');
    const launcher = text(row.launcher, 'Harness自带命令入口', 4096);
    requireCondition(path.isAbsolute(launcher) && path.basename(launcher).toLowerCase() === 'dsh.cmd' && !/["%&|<>^!\r\n]/.test(launcher), 'INVALID_LAUNCHER', '请使用Harness自带的dsh.cmd绝对路径，不接受任务内容作为启动命令。');
    const profile = text(row.profile, '专用配置名称', 80);
    requireCondition(/^work-handoff[a-z0-9-]*$/.test(profile), 'INVALID_HARNESS_PROFILE', '必须使用本项目专用SDK配置，不能启动普通桌面配置。');
    requireCondition(row.provider === 'deepseek-account', 'PROVIDER_NOT_ALLOWED', '当前接入只使用Harness现有DeepSeek登录，不切换API或其他服务。');
    const result = { launcher, profile, provider: 'deepseek-account', model: text(row.model, '模型', 128) };
    // Omit the optional override to use the installed provider's native generation budget.
    if (row.maxTokens !== undefined)
        result.maxTokens = positive(row.maxTokens, '输出上限');
    if (row.reasoningEffort !== undefined)
        result.reasoningEffort = text(row.reasoningEffort, '思考设置', 80);
    return result;
}
function runtimeEnvironment() {
    const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
        'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'OS', 'PSMODULEPATH']);
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
}
export function harnessLaunch(endpoint, cwd) {
    const config = validateEndpoint(endpoint);
    requireCondition(process.platform === 'win32', 'UNSUPPORTED_PLATFORM', '此安装适配器针对Windows自带命令入口。');
    checkedRoot(path.dirname(config.launcher));
    requireCondition(lstatSync(config.launcher).isFile() && !lstatSync(config.launcher).isSymbolicLink(), 'INVALID_LAUNCHER', 'Harness命令入口不能是链接。');
    const system = checkedRoot(process.env.SystemRoot ?? 'C:\\Windows');
    return { executable: resourcePath(system, 'System32/cmd.exe'), args: ['/d', '/s', '/c', `""${config.launcher}" --profile ${config.profile}"`],
        cwd: checkedRoot(cwd), env: runtimeEnvironment() };
}
/** One owned SDK process, strict stdio framing; no listener, credentials, or prompt retry. */
export class HarnessSdk {
    child;
    pending = new Map();
    sequence = 0;
    buffer = '';
    decoder = new StringDecoder('utf8');
    fault = null;
    protocolIssue = null;
    initialized = false;
    startupDiagnosticCount = 0;
    observers = new Set();
    closing;
    hasExited = false;
    exitCode = null;
    constructor(launch) {
        this.child = spawn(launch.executable, launch.args, { cwd: checkedRoot(launch.cwd), env: launch.env ?? runtimeEnvironment(),
            windowsHide: true, shell: false, windowsVerbatimArguments: process.platform === 'win32' && path.basename(launch.executable).toLowerCase() === 'cmd.exe',
            stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.on('error', () => this.fail(new HandoffError('HARNESS_START_FAILED', 'Harness后台执行端未能启动。')));
        this.child.stdin.on('error', () => this.fail(new HandoffError('SDK_INPUT_CLOSED', 'SDK输入通道已关闭，不能判断指令是否接收。')));
        this.child.stderr.on('data', () => { });
        this.child.stdout.on('data', (chunk) => {
            try {
                this.buffer += this.decoder.write(chunk);
                let newline;
                while ((newline = this.buffer.indexOf('\n')) >= 0) {
                    const line = this.buffer.slice(0, newline);
                    this.buffer = this.buffer.slice(newline + 1);
                    requireCondition(Buffer.byteLength(line) <= 8_388_608, 'SDK_FRAME_TOO_LARGE', 'SDK消息超过接入上限。');
                    if (line.trim()) {
                        // Desktop 0.2.1's account adapter emits tagged catalog diagnostics before SDK readiness.
                        // Tolerate only that known startup prefix, bounded and never recorded or treated as a receipt.
                        if (!this.initialized && /^\[llm-deepseek-account\]/.test(line) && Buffer.byteLength(line) <= 4096 && this.startupDiagnosticCount < 16) {
                            this.startupDiagnosticCount++;
                            continue;
                        }
                        let value;
                        try {
                            value = JSON.parse(line);
                        }
                        catch {
                            this.protocolIssue = 'Non-JSON stdout; content deliberately omitted';
                            throw new Error('Non-JSON stdout');
                        }
                        try {
                            this.frame(value);
                        }
                        catch (error) {
                            this.protocolIssue = error instanceof HandoffError ? error.code + ': ' + error.message : 'Notification observer failed';
                            throw error;
                        }
                    }
                }
                requireCondition(Buffer.byteLength(this.buffer) <= 8_388_608, 'SDK_FRAME_TOO_LARGE', 'SDK消息超过接入上限。');
            }
            catch {
                this.fail(new HandoffError('SDK_PROTOCOL_ERROR', 'SDK消息不符合当前接入协议，已停止接收成果。'));
            }
        });
        this.child.on('close', code => {
            this.hasExited = true;
            this.exitCode = code;
            this.fail(new HandoffError('SDK_TRANSPORT_CLOSED', 'Harness执行进程已退出；未结算指令需要核实。'));
        });
    }
    get pid() { return this.child.pid ?? null; }
    get failure() { return this.fault; }
    get diagnostic() { return this.protocolIssue; }
    get ignoredStartupDiagnostics() { return this.startupDiagnosticCount; }
    get exited() { return this.hasExited; }
    subscribe(observer) { this.observers.add(observer); return () => this.observers.delete(observer); }
    fail(error) {
        this.fault ??= error;
        for (const entry of this.pending.values()) {
            if (entry.timer)
                clearTimeout(entry.timer);
            entry.reject(this.fault);
        }
        this.pending.clear();
    }
    frame(value) {
        requireCondition(object(value) && value.jsonrpc === '2.0', 'SDK_PROTOCOL_ERROR', 'SDK帧格式不正确。');
        if (typeof value.method === 'string') {
            if ('id' in value) {
                this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Interactive permission requests require the user; no automatic approval' } }) + '\n');
                this.fail(new HandoffError('HARNESS_MANUAL_ACTION_REQUIRED', '执行端请求交互操作，请由用户在正常界面处理。'));
                return;
            }
            for (const observer of this.observers)
                observer({ method: value.method, params: value.params });
            return;
        }
        requireCondition(typeof value.id === 'number' && (('result' in value) !== ('error' in value)), 'SDK_PROTOCOL_ERROR', 'SDK回执格式不正确。');
        const entry = this.pending.get(value.id);
        if (!entry)
            return;
        if (entry.timer)
            clearTimeout(entry.timer);
        this.pending.delete(value.id);
        if ('error' in value)
            entry.reject(new HandoffError('SDK_REQUEST_REJECTED', 'Harness拒绝了SDK请求；请检查当前登录、模型或接口兼容性。'));
        else
            entry.resolve(value.result);
    }
    request(method, params, timeoutMs = 30_000) {
        if (this.fault)
            return Promise.reject(this.fault);
        const requestId = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = timeoutMs === null ? null : setTimeout(() => {
                this.pending.delete(requestId);
                reject(new HandoffError('SDK_REQUEST_TIMEOUT', 'SDK请求超时，不能盲目重发。'));
            }, positive(timeoutMs, '请求时限'));
            this.pending.set(requestId, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }) + '\n');
        });
    }
    async initialize(endpoint, cwd) {
        const result = await this.request('initialize', { cwd: checkedRoot(cwd), provider: endpoint.provider, model: endpoint.model,
            ...(endpoint.maxTokens === undefined ? {} : { maxTokens: endpoint.maxTokens }),
            ...(endpoint.reasoningEffort === undefined ? {} : { reasoningEffort: endpoint.reasoningEffort }) });
        requireCondition(object(result) && object(result.serverInfo) && result.serverInfo.name === 'deepseek-harness-sdk-runtime'
            && typeof result.serverInfo.version === 'string', 'SDK_IDENTITY_MISMATCH', '执行端身份与官方SDK握手不符。');
        this.initialized = true;
        return { name: result.serverInfo.name, version: result.serverInfo.version };
    }
    async waitUntil(predicate, deadline, check = () => { }) {
        while (!predicate()) {
            check();
            if (this.fault)
                throw this.fault;
            requireCondition(deadline === null || Date.now() < deadline, 'EXECUTION_TIMEOUT', '本次执行时间已到，保存状态并结算。');
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        check();
    }
    async exitWithin(milliseconds) {
        if (this.hasExited)
            return true;
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.child.off('close', done); resolve(true); };
            const timer = setTimeout(() => { this.child.off('close', done); resolve(this.hasExited); }, milliseconds);
            this.child.once('close', done);
        });
    }
    close() { this.closing ??= this.dispose(); return this.closing; }
    async dispose() {
        let shutdownAcknowledged = false;
        if (!this.hasExited && !this.fault) {
            try {
                await this.request('shutdown', undefined, 8000);
                shutdownAcknowledged = true;
            }
            catch { /* Preserve unknown state on shutdown failure. */ }
        }
        this.child.stdin.end();
        const exited = await this.exitWithin(8000);
        if (!exited) {
            // A wrapper exit or forced termination does not prove its runtime/tools stopped. Never kill unrelated processes or pretend settlement.
            this.child.unref();
            this.child.stdin.destroy();
            this.child.stdout.destroy();
            this.child.stderr.destroy();
        }
        return { shutdownAcknowledged, exited, code: this.exitCode };
    }
}
/** Folds only the single, newly created root session; other sessions and raw account logs are discarded. */
export class SessionEvidence {
    sessionId;
    admitted = new Set();
    stepStarted = false;
    finalText = '';
    turnReason = null;
    lastSequence = -1;
    eventCount = 0;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    observe(notification) {
        if (notification.method !== 'session.event' || !object(notification.params) || notification.params.sessionId !== this.sessionId)
            return;
        const event = notification.params.event;
        requireCondition(object(event) && typeof event.type === 'string' && Number.isSafeInteger(event.seq) && Number(event.seq) >= 0
            && (this.lastSequence === -1 || Number(event.seq) === this.lastSequence + 1), 'SDK_EVENT_ORDER', '执行端事件格式或顺序不正确。');
        this.lastSequence = Number(event.seq);
        this.eventCount++;
        requireCondition(this.eventCount <= 100_000, 'SDK_EVENT_LIMIT', '执行事件过多，停止自动处理。');
        if (event.type === 'agent/inbox/spliced' && object(event.data) && Array.isArray(event.data.inserted)) {
            for (const message of event.data.inserted)
                if (object(message) && typeof message.id === 'string')
                    this.admitted.add(message.id);
        }
        if (event.type === 'user/message' && object(event.data) && typeof event.data.id === 'string')
            this.admitted.add(event.data.id);
        if (event.type === 'step/start')
            this.stepStarted = true;
        if (event.type === 'assistant/message') {
            requireCondition(object(event.data) && object(event.data.message) && Array.isArray(event.data.message.content), 'SDK_BAD_OUTPUT', '执行端成果格式不正确。');
            this.finalText = event.data.message.content.filter(block => object(block) && block.type === 'text').map(block => {
                requireCondition(typeof block.text === 'string', 'SDK_BAD_OUTPUT', '执行端文本块格式不正确。');
                return String(block.text);
            }).join('');
            requireCondition(Buffer.byteLength(this.finalText) <= 1_048_576, 'SDK_BAD_OUTPUT', '执行端成果文本过大。');
        }
        if (event.type === 'turn/end') {
            requireCondition(object(event.data) && object(event.data.reason) && typeof event.data.reason.kind === 'string', 'SDK_BAD_TERMINAL', '执行端结束原因不正确。');
            this.turnReason = event.data.reason.kind;
        }
    }
}
//# sourceMappingURL=harness-sdk.js.map
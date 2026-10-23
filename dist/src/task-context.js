import path from 'node:path';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { id, record, requireCondition, strings, text } from './contracts.js';
import { checkedRoot, digest, fingerprint, pathKey, relativePath, resourcePath } from './packet.js';
export function taskContextPolicy(value, workRoot) {
    const row = record(value, ['root'], '自动任务资料目录'), root = checkedRoot(row.root);
    requireCondition(!inside(root, workRoot) && !inside(workRoot, root), 'OVERLAPPING_CONTEXT_ROOT', '自动资料与执行副本目录须分开。');
    return { root };
}
const inside = (filename, root) => pathKey(filename) === pathKey(root) || pathKey(filename).startsWith(pathKey(root + path.sep));
const privatePart = (name) => /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.dsh|\.env(?:\.(?!example$|sample$|template$).*)?|id_rsa|id_ed25519|credentials(?:\.json)?|auth\.json)$/i.test(name)
    || /\.(?:pem|p12|pfx|key)$/i.test(name);
const skipDirectory = (name) => privatePart(name) || /^(?:node_modules|\.local|\.local-tests|\.venv|venv|dist|build|release|AppData|Windows|Program Files(?: \(x86\))?)$/i.test(name);
function safeFile(filename) {
    const full = path.resolve(filename);
    requireCondition(existsSync(full), 'RESOURCE_NOT_FOUND', '本对话引用的文件已不存在；请核对现有附件或实际文件，不猜测其他目录。');
    requireCondition(!full.split(path.sep).some(privatePart), 'SENSITIVE_RESOURCE', '资源涉及凭据或私钥路径，未自动打包。请核实确实需要哪些非敏感内容。');
    fingerprint(checkedRoot(path.dirname(full)), path.basename(full));
    return full;
}
function usableRoot(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !existsSync(value))
        return null;
    const root = checkedRoot(value);
    const userHome = process.env.USERPROFILE ?? process.env.HOME;
    if (pathKey(root) === pathKey(path.parse(root).root) || (userHome && pathKey(root) === pathKey(path.resolve(userHome))) || root.split(path.sep).some(privatePart))
        return null;
    return root;
}
function locate(root, name) {
    const direct = resourcePath(root, relativePath(name), false);
    if (existsSync(direct))
        return { paths: [safeFile(direct)], incomplete: false };
    if (name.includes('/'))
        return { paths: [], incomplete: false };
    const found = [], queue = [root];
    let visited = 0, unreadable = false;
    while (queue.length && visited < 10_000) {
        const dir = queue.shift();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            unreadable = true;
            continue;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++visited > 10_000)
                break;
            if (entry.isSymbolicLink())
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skipDirectory(entry.name))
                    queue.push(full);
            }
            else if (entry.isFile() && pathKey(entry.name) === pathKey(name))
                found.push(safeFile(full));
        }
    }
    return { paths: found, incomplete: unreadable || queue.length > 0 || visited > 10_000 };
}
export class TaskContexts {
    store;
    policy;
    workRoot;
    constructor(store, policy, workRoot) {
        this.store = store;
        this.policy = policy;
        this.workRoot = workRoot;
    }
    get(taskId, conversationId) {
        const previous = this.store.get('task-context', taskId);
        requireCondition(!previous || previous.conversationId === conversationId, 'WRONG_CONVERSATION', '任务资料属于其他原对话，不能接管。');
        return previous;
    }
    prepare(input) {
        const taskId = id(input.taskId), conversationId = id(input.conversationId), previous = this.get(taskId, conversationId);
        const names = strings(input.files ?? [], '当前任务引用文件', true);
        requireCondition(names.length <= 256, 'INVALID_RESOURCES', '单任务最多256项明确文件；由GPT按任务拆分，不收集整个磁盘。');
        const hook = this.store.get('quota-hook', conversationId);
        const explicitRoot = input.projectRoot === undefined ? null : usableRoot(input.projectRoot);
        requireCondition(input.projectRoot === undefined || explicitRoot, 'INVALID_CONTEXT_ROOT', '提供的工程目录无效；可省略，由当前对话定位。');
        const cwd = explicitRoot ?? (previous?.source === 'project' || names.length ? usableRoot(previous?.resourceRoot ?? hook?.cwd) : null);
        const resolved = [], choices = [];
        for (const name of names) {
            if (path.isAbsolute(name)) {
                resolved.push(safeFile(name));
                continue;
            }
            if (!cwd) {
                choices.push({ file: name, candidates: [] });
                continue;
            }
            const result = locate(cwd, name.replaceAll('\\', '/'));
            if (result.paths.length === 1 && !result.incomplete)
                resolved.push(result.paths[0]);
            else
                choices.push({ file: name, candidates: result.paths.map(full => path.relative(cwd, full).replaceAll('\\', '/')) });
        }
        if (choices.length)
            return { state: 'needs-selection', reason: 'FILE_REFERENCE_UNRESOLVED', choices,
                message: '先根据本对话的附件、已读写文件及工程信息补全；确有多个同名文件时，将所有歧义合并成一次简短选择，不要求用户填写绝对路径。' };
        let source, root;
        if (cwd && resolved.every(full => inside(full, cwd))) {
            root = cwd;
            source = 'project';
        }
        else if (resolved.length) {
            root = path.dirname(resolved[0]);
            while (!resolved.every(full => inside(full, root)) && root !== path.dirname(root))
                root = path.dirname(root);
            if (pathKey(root) === pathKey(path.parse(root).root))
                return { state: 'needs-selection', reason: 'MULTIPLE_SOURCE_ROOTS', choices: names.map(file => ({ file, candidates: [] })),
                    message: '文件跨盘或只能归到磁盘根目录。由GPT按已有文件位置拆为关联子任务；不能猜测根目录或要求用户逐个输入路径。' };
            source = 'selected-files';
        }
        else {
            root = path.join(this.policy.root, digest({ taskId, conversationId }).slice(0, 32));
            mkdirSync(root, { recursive: true });
            checkedRoot(root);
            source = 'conversation';
        }
        root = checkedRoot(root);
        requireCondition(!inside(root, this.workRoot) && !inside(this.workRoot, root), 'OVERLAPPING_ROOTS', '任务来源与执行副本须分开，不能递归收集本工具的运行数据。');
        requireCondition(!previous || pathKey(previous.resourceRoot) === pathKey(root), 'CONTEXT_ROOT_CHANGED', '已登记的任务来源目录变化，保留原任务；请核对任务身份再继续。');
        let files = resolved.map(full => path.relative(root, full).replaceAll('\\', '/'));
        requireCondition(new Set(files.map(pathKey)).size === files.length, 'DUPLICATE_RESOURCE', '同一文件不能通过多个名称重复交接。');
        if (source === 'conversation') {
            const summary = text(input.summary, 'GPT自动整理的任务交接摘要', 120_000), content = summary + '\n';
            const filename = 'handoff-brief-' + digest(content).slice(0, 16) + '.md', full = resourcePath(root, filename, false);
            if (existsSync(full))
                requireCondition(lstatSync(full).isFile() && readFileSync(full, 'utf8') === content, 'CONTEXT_NOTE_CONFLICT', '自动交接摘要已被改动，保留现场。');
            else
                writeFileSync(full, content, { flag: 'wx' });
            files = [filename];
        }
        const context = { taskId, conversationId, resourceRoot: root, workRoot: this.workRoot, files, source };
        this.store.saveContext(taskId, context);
        return { state: 'ready', requiresUserConfirmation: false, ...context };
    }
}
//# sourceMappingURL=task-context.js.map
import path from 'node:path';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { canonical, id, positive, record, requireCondition, side, strings, text } from './contracts.js';
import type { Output, Packet, Resource } from './contracts.js';

const fields = ['schemaVersion', 'taskId', 'version', 'requirementsVersion', 'createdAt', 'title', 'objective',
  'requirements', 'summary', 'remainingWork', 'acceptanceCriteria', 'conversationId', 'resourceRoot', 'workRoot',
  'recipients', 'resources', 'deadlineAt', 'maxRework'];
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;

export function relativePath(value: unknown): string {
  const name = text(value, '资源路径', 1024);
  requireCondition(!path.isAbsolute(name) && !/[\\:\x00-\x1f]/.test(name), 'INVALID_PATH', '资源路径必须使用相对路径和正斜线，不能含盘符或数据流。');
  requireCondition(name.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
    && !/[ .]$/.test(part) && !/[<>"|?*]/.test(part)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), 'INVALID_PATH', '资源路径包含越界或不支持的片段。');
  return name;
}
export function checkedRoot(value: unknown): string {
  const root = text(value, '资料根目录', 4096);
  requireCondition(path.isAbsolute(root), 'ABSOLUTE_ROOT_REQUIRED', '资料根目录必须为明确的绝对路径。');
  const resolved = path.resolve(root);
  requireCondition(!lstatSync(resolved).isSymbolicLink() && lstatSync(resolved).isDirectory()
    && pathKey(realpathSync(resolved)) === pathKey(resolved), 'LINKED_ROOT', '资料根目录不能是链接或联接。');
  return resolved;
}
// This checks this tool's declared paths, not the permissions of other applications.
export function resourcePath(root: string, name: string, mustExist = true): string {
  relativePath(name);
  const target = path.resolve(root, ...name.split('/'));
  requireCondition(pathKey(target).startsWith(pathKey(root + path.sep)), 'PATH_ESCAPE', '资源越出指定资料目录。');
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try { requireCondition(!lstatSync(current).isSymbolicLink(), 'LINKED_RESOURCE', '资源路径不能经过链接或联接。'); }
    catch (error) { if (!mustExist && (error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
  }
  return target;
}
export function fingerprint(root: string, name: string): Resource {
  const target = resourcePath(checkedRoot(root), relativePath(name));
  const before = lstatSync(target);
  requireCondition(before.isFile(), 'NOT_A_FILE', '任务资源必须为明确文件，不递归收集目录。');
  const fd = openSync(target, 'r');
  try {
    const opened = fstatSync(fd);
    requireCondition(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev, 'FILE_CHANGED', '资源在读取前发生变化。');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let position = 0, count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, position)) > 0) { hash.update(buffer.subarray(0, count)); position += count; }
    const after = fstatSync(fd), named = lstatSync(target);
    requireCondition(position === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs
      && after.ctimeMs === opened.ctimeMs && !named.isSymbolicLink() && named.ino === opened.ino
      && named.dev === opened.dev && named.size === opened.size && named.mtimeMs === opened.mtimeMs,
    'FILE_CHANGED', '资源在读取期间发生变化，请重新生成任务包。');
    return { path: name, bytes: position, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}
export function resources(value: unknown): Resource[] {
  requireCondition(Array.isArray(value) && value.length <= 256, 'INVALID_RESOURCES', '资源清单必须是显式列表，最多256项。');
  const seen = new Set<string>();
  return value.map(item => {
    const row = record(item, ['path', 'bytes', 'sha256'], '资源');
    const name = relativePath(row.path), key = pathKey(name);
    requireCondition(!seen.has(key), 'DUPLICATE_RESOURCE', '资源路径重复。'); seen.add(key);
    requireCondition(Number.isSafeInteger(row.bytes) && Number(row.bytes) >= 0, 'INVALID_SIZE', '文件大小不正确。');
    requireCondition(typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256), 'INVALID_HASH', '文件指纹不正确。');
    return { path: name, bytes: Number(row.bytes), sha256: row.sha256 };
  });
}
export function verifyResources(root: string, files: Resource[]): void {
  checkedRoot(root);
  for (const expected of resources(files)) {
    const actual = fingerprint(root, expected.path);
    requireCondition(actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
      'RESOURCE_CHANGED', `资源已改变：${expected.path}。`);
  }
}
export function validatePacket(value: unknown): Packet {
  const row = record(value, fields, '任务包');
  requireCondition(row.schemaVersion === 1, 'UNSUPPORTED_SCHEMA', '任务包版本不支持。');
  const createdAt = positive(row.createdAt, '创建时间');
  const deadlineAt = row.deadlineAt === undefined || row.deadlineAt === null ? null : positive(row.deadlineAt, '期限');
  requireCondition(deadlineAt === null || deadlineAt > createdAt,
    'INVALID_DEADLINE', '明确指定的任务期限必须晚于创建时间；未指定则不设期限。');
  requireCondition(row.maxRework === 1, 'INVALID_REWORK_POLICY', '最多允许一次返工。');
  requireCondition(Array.isArray(row.recipients) && row.recipients.length > 0 && row.recipients.length <= 2, 'INVALID_RECIPIENTS', '必须明确资料接收端。');
  const recipients = row.recipients.map(side);
  requireCondition(new Set(recipients).size === recipients.length, 'INVALID_RECIPIENTS', '接收端重复。');
  const root = text(row.resourceRoot, '资料根目录', 4096);
  const workRoot = text(row.workRoot, '工作副本根目录', 4096);
  requireCondition(path.isAbsolute(root) && path.resolve(root) === root, 'INVALID_ROOT', '资料根目录必须是规范绝对路径。');
  requireCondition(path.isAbsolute(workRoot) && path.resolve(workRoot) === workRoot, 'INVALID_ROOT', '工作副本根目录必须是规范绝对路径。');
  requireCondition(pathKey(root) !== pathKey(workRoot) && !pathKey(root).startsWith(pathKey(workRoot + path.sep))
    && !pathKey(workRoot).startsWith(pathKey(root + path.sep)), 'OVERLAPPING_ROOTS', '输入资料与工作副本目录必须分开。');
  const packet: Packet = { schemaVersion: 1, taskId: id(row.taskId), version: positive(row.version, '任务包版本'),
    requirementsVersion: positive(row.requirementsVersion, '要求版本'), createdAt,
    title: text(row.title, '标题', 256), objective: text(row.objective, '目标'), requirements: strings(row.requirements, '原始要求'),
    summary: text(row.summary, '摘要'), remainingWork: strings(row.remainingWork, '待办', true),
    acceptanceCriteria: strings(row.acceptanceCriteria, '验收条件'), conversationId: text(row.conversationId, '原会话标识', 256),
    resourceRoot: root, workRoot, recipients, resources: resources(row.resources), deadlineAt, maxRework: 1 };
  requireCondition(Buffer.byteLength(canonical(packet)) <= 1_048_576, 'PACKET_TOO_LARGE', '任务包元数据超过1 MiB，文件内容应通过资源清单引用。');
  return packet;
}
// Input explicitly names files. Nothing enumerates a user's folder or chat history.
export function createPacket(value: unknown, now = Date.now()): Packet {
  const input = record(value, [...fields.filter(field => !['schemaVersion', 'createdAt', 'resources', 'maxRework'].includes(field)), 'files'], '任务输入');
  const root = checkedRoot(input.resourceRoot), files = strings(input.files, '指定文件', true);
  const workRoot = checkedRoot(input.workRoot);
  const base = { ...input }; delete base.files;
  return validatePacket({ ...base, resourceRoot: root, workRoot, schemaVersion: 1, createdAt: now,
    resources: files.map(name => fingerprint(root, name)), maxRework: 1 });
}
export function validateOutput(value: unknown, root: string): Output {
  const row = record(value, ['summary', 'acceptanceNotes', 'files'], '成果');
  const output = { summary: text(row.summary, '成果摘要'), acceptanceNotes: strings(row.acceptanceNotes, '验收说明', true), files: resources(row.files) };
  requireCondition(Buffer.byteLength(canonical(output)) <= 1_048_576, 'OUTPUT_TOO_LARGE', '成果元数据过大。');
  if (output.files.length > 0) verifyResources(root, output.files);
  return output;
}

export const SCHEMA_VERSION = 1;
export class HandoffError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'HandoffError';
    }
}
export function requireCondition(value, code, message) {
    if (!value)
        throw new HandoffError(code, message);
}
export function text(value, name, max = 32_768) {
    requireCondition(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), 'INVALID_TEXT', `${name}必须是长度合适的非空文本。`);
    return value;
}
export function id(value, name = '编号') {
    const result = text(value, name, 128);
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result), 'INVALID_ID', `${name}包含不支持的字符。`);
    return result;
}
export function positive(value, name) {
    requireCondition(Number.isSafeInteger(value) && Number(value) > 0, 'INVALID_NUMBER', `${name}必须为正整数。`);
    return Number(value);
}
export function record(value, fields, name) {
    requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT', `${name}格式不正确。`);
    const result = value;
    requireCondition(Object.keys(result).every(key => fields.includes(key)), 'UNKNOWN_FIELD', `${name}含有未支持的字段。`);
    return result;
}
export function strings(value, name, allowEmpty = false) {
    requireCondition(Array.isArray(value) && value.length <= 256 && (allowEmpty || value.length > 0), 'INVALID_LIST', `${name}必须是明确的文本列表。`);
    return value.map(item => text(item, name));
}
export function side(value) {
    requireCondition(value === 'work' || value === 'harness', 'INVALID_SIDE', '执行方不正确。');
    return value;
}
export function canonical(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        requireCondition(Number.isFinite(value), 'INVALID_JSON', '记录不支持非有限数值。');
        return JSON.stringify(value);
    }
    requireCondition(typeof value === 'object', 'INVALID_JSON', '记录只能包含明确的JSON数据。');
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    const row = value;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
export const terminal = (status) => ['succeeded', 'failed', 'cancelled', 'superseded'].includes(status);
export const inFlight = (status) => !terminal(status) && status !== 'queued';
//# sourceMappingURL=contracts.js.map
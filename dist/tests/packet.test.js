import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPacket, fingerprint, relativePath, validatePacket, verifyResources } from '../src/packet.js';
import { baseTime, errorCode, fixture } from './helpers.js';
test('packet records only named files, requirements, original chat, recipients and fingerprints', t => {
    const f = fixture(t), packet = f.packet();
    assert.equal(packet.schemaVersion, 1);
    assert.equal(packet.conversationId, 'original-chat');
    assert.deepEqual(packet.resources.map(file => file.path), ['input.txt']);
    assert.equal(packet.resources[0]?.sha256, fingerprint(f.resources, 'input.txt').sha256);
    assert(!JSON.stringify(packet).includes('only designated task content'));
    assert.deepEqual(validatePacket(JSON.parse(JSON.stringify(packet))), packet);
});
test('empty explicit file list is valid; it never enumerates all files', t => {
    const f = fixture(t);
    assert.deepEqual(createPacket({ ...f.input(), files: [] }, baseTime).resources, []);
});
test('unknown fields, wrong schemas, incomplete acceptance and third-party recipients are rejected', t => {
    const f = fixture(t), packet = f.packet();
    assert.throws(() => createPacket({ ...f.input(), uploadUrl: 'https://invalid.example' }, baseTime), errorCode('UNKNOWN_FIELD'));
    assert.throws(() => validatePacket({ ...packet, schemaVersion: 2 }), errorCode('UNSUPPORTED_SCHEMA'));
    assert.throws(() => validatePacket({ ...packet, acceptanceCriteria: [] }), errorCode('INVALID_LIST'));
    assert.throws(() => validatePacket({ ...packet, recipients: ['proxy'] }), errorCode('INVALID_SIDE'));
    assert.throws(() => validatePacket({ ...packet, recipients: ['work', 'work'] }), errorCode('INVALID_RECIPIENTS'));
});
test('path traversal, alternate streams and Windows special names are rejected', () => {
    for (const name of ['../secret', '/absolute', 'C:/file', 'a\\b', 'file:stream', 'a/./b', 'a//b', 'con.txt', 'x./b', 'a?b'])
        assert.throws(() => relativePath(name), errorCode('INVALID_PATH'));
});
test('missing files, directory resources, duplicates and changed fingerprints do not silently pass', t => {
    const f = fixture(t);
    assert.throws(() => createPacket({ ...f.input(), files: ['missing.txt'] }, baseTime));
    mkdirSync(path.join(f.resources, 'folder'));
    assert.throws(() => createPacket({ ...f.input(), files: ['folder'] }, baseTime), errorCode('NOT_A_FILE'));
    assert.throws(() => createPacket({ ...f.input(), files: ['input.txt', 'input.txt'] }, baseTime), errorCode('DUPLICATE_RESOURCE'));
    const packet = f.packet();
    writeFileSync(path.join(f.resources, 'input.txt'), 'changed');
    assert.throws(() => verifyResources(packet.resourceRoot, packet.resources), errorCode('RESOURCE_CHANGED'));
});
test('directory junction cannot redirect resource reading outside the declared root', t => {
    const f = fixture(t), other = path.join(f.root, 'outside');
    mkdirSync(other);
    writeFileSync(path.join(other, 'private.txt'), 'not part of resource root');
    symlinkSync(other, path.join(f.resources, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createPacket({ ...f.input(), files: ['link/private.txt'] }, baseTime), errorCode('LINKED_RESOURCE'));
    assert.throws(() => createPacket({ ...f.input(), resourceRoot: path.join(f.resources, 'link') }, baseTime), errorCode('LINKED_ROOT'));
});
test('only an explicit deadline constrains the task window; a single rework remains required', t => {
    const f = fixture(t), packet = f.packet();
    assert.equal(validatePacket({ ...packet, deadlineAt: baseTime + 18_000_001 }).deadlineAt, baseTime + 18_000_001);
    assert.throws(() => validatePacket({ ...packet, deadlineAt: baseTime }), errorCode('INVALID_DEADLINE'));
    const input = { ...f.input(), deadlineAt: undefined };
    assert.equal(createPacket(input, baseTime).deadlineAt, null);
    assert.throws(() => validatePacket({ ...packet, maxRework: 2 }), errorCode('INVALID_REWORK_POLICY'));
});
test('input and worker output roots cannot overlap', t => {
    const f = fixture(t), packet = f.packet();
    assert.throws(() => validatePacket({ ...packet, workRoot: packet.resourceRoot }), errorCode('OVERLAPPING_ROOTS'));
    assert.throws(() => validatePacket({ ...packet, workRoot: path.join(packet.resourceRoot, 'work') }), errorCode('OVERLAPPING_ROOTS'));
});
//# sourceMappingURL=packet.test.js.map